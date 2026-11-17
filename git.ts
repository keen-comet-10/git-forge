// Git smart HTTP, implemented from the protocol itself: pkt-lines, packfiles (read and
// write, with OFS/REF delta resolution), protocol v2 ls-refs and fetch for upload-pack, and
// v0 receive-pack with report-status over side-band-64k. Objects live in the store's
// per-repository map; nothing here shells out to a git binary (there is none in the trial).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTagTarget,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export const PKT_MAX_PAYLOAD = 65_520 - 4;

/** Encode one data pkt-line. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every pkt-line in a buffer; throws on a malformed frame. */
export function decodePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------- packfiles

const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  /** For delta entries: the base's pack offset (OFS) or object id (REF). */
  ofsBase?: number;
  refBase?: string;
  deltaData?: Buffer;
}

/**
 * Read a packfile into full objects. `external` resolves REF_DELTA bases the pack itself
 * does not carry (a thin pack against the repository's own store).
 */
export function readPack(
  pack: Buffer,
  external?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  const entries = new Map<number, PackEntry>();
  const byOid = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA
      let b = pack[offset]!;
      offset += 1;
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) * 128) + (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      entries.set(entryOffset, { type: 'blob', data: Buffer.alloc(0), ofsBase: entryOffset - baseOffset, deltaData: inflated.data });
    } else if (typeId === 7) {
      // REF_DELTA
      const refBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      entries.set(entryOffset, { type: 'blob', data: Buffer.alloc(0), refBase, deltaData: inflated.data });
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      entries.set(entryOffset, { type, data: inflated.data });
    }
  }
  const offsetByOid = new Map<string, number>();
  for (const [entryOffset, entry] of entries) {
    if (entry.deltaData === undefined) offsetByOid.set(hashObject(entry.type, entry.data), entryOffset);
  }
  const resolved = new Map<number, GitObject>();
  const resolve = (entryOffset: number, guard: number): GitObject => {
    if (guard > 64) throw new Error('delta chain too deep');
    const memo = resolved.get(entryOffset);
    if (memo !== undefined) return memo;
    const entry = entries.get(entryOffset);
    if (entry === undefined) throw new Error('delta base missing from pack');
    let object: GitObject;
    if (entry.deltaData === undefined) {
      object = { type: entry.type, data: entry.data };
    } else {
      let base: GitObject;
      if (entry.ofsBase !== undefined) {
        base = resolve(entry.ofsBase, guard + 1);
      } else {
        const baseOffset = offsetByOid.get(entry.refBase!);
        if (baseOffset !== undefined) base = resolve(baseOffset, guard + 1);
        else {
          const found = external?.(entry.refBase!);
          if (found === undefined) throw new Error('thin pack base not available');
          base = found;
        }
      }
      object = { type: base.type, data: applyDelta(base.data, entry.deltaData) };
    }
    resolved.set(entryOffset, object);
    return object;
  };
  for (const entryOffset of entries.keys()) {
    const object = resolve(entryOffset, 0);
    byOid.set(hashObject(object.type, object.data), object);
  }
  return byOid;
}

/** Write a packfile of full (non-delta) objects, version 2, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push((typeId << 4) | first | 0x80);
      while (size > 0) {
        let b = size & 0x7f;
        size >>= 7;
        if (size > 0) b |= 0x80;
        bytes.push(b);
      }
    } else {
      bytes.push((typeId << 4) | first);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from the tips (commits walk parents; tags peel; trees recurse). */
export function collectReachable(
  repo: Repo,
  tips: Iterable<string>,
  options: { shallowCut?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!options.shallowCut?.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTagTarget(object.data).object);
    }
  }
  return seen;
}

export interface FetchPlan {
  /** Object ids to put in the pack. */
  send: string[];
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** The client's old boundary commits that are no longer shallow. */
  unshallow: string[];
}

/**
 * Plan a fetch: the objects the client lacks, honouring haves, the client's shallow
 * boundary and an optional depth (the depth a deepen asks for is the total depth from
 * the wants, as protocol v2 defines it).
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowCut = new Set(clientShallow);
  const haveSet = collectReachable(repo, haves, { shallowCut });
  const send = new Set<string>();
  const boundary = new Set<string>();

  if (depth === null) {
    for (const oid of collectReachable(repo, wants)) {
      if (!haveSet.has(oid)) send.add(oid);
    }
  } else {
    // Commit distances from the wants (a wanted tag counts its commit as distance 1).
    const distance = new Map<string, number>();
    const queue: Array<{ oid: string; dist: number }> = [];
    const enqueue = (oid: string, dist: number): void => {
      const object = repo.objects.get(oid);
      if (object === undefined) return;
      if (object.type === 'tag') {
        if (!haveSet.has(oid)) send.add(oid);
        enqueue(parseTagTarget(object.data).object, dist);
        return;
      }
      if (object.type !== 'commit') return;
      const known = distance.get(oid);
      if (known !== undefined && known <= dist) return;
      distance.set(oid, dist);
      queue.push({ oid, dist });
    };
    for (const want of wants) enqueue(want, 1);
    while (queue.length > 0) {
      const { oid, dist } = queue.shift()!;
      if (distance.get(oid) !== dist) continue;
      const commit = parseCommit(repo.objects.get(oid)!.data);
      if (dist < depth) {
        for (const parent of commit.parents) enqueue(parent, dist + 1);
      }
    }
    const included = new Set<string>();
    for (const [oid, dist] of distance) {
      if (dist > depth) continue;
      included.add(oid);
      if (!haveSet.has(oid)) send.add(oid);
      const commit = parseCommit(repo.objects.get(oid)!.data);
      if (dist === depth && commit.parents.length > 0) boundary.add(oid);
    }
    // The trees and blobs of every included commit the client lacks.
    for (const oid of included) {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      for (const sub of collectReachable(repo, [commit.tree])) {
        if (!haveSet.has(sub)) send.add(sub);
      }
    }
    // A boundary commit the client already holds as a normal commit is not shallow.
    for (const oid of [...boundary]) if (haveSet.has(oid) && !shallowCut.has(oid)) boundary.delete(oid);
  }

  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!boundary.has(oid) && (send.has(oid) || repo.objects.has(oid))) {
      // The old boundary commit is part of this fetch's history and no longer at its edge:
      // it counts as unshallowed when its parents are now reachable for the client, which
      // the deepen flow shows by the commit being an included non-boundary commit.
      if (depth !== null) unshallow.push(oid);
    }
  }
  return { send: [...send], shallow: [...boundary], unshallow };
}

// ---------------------------------------------------------------- advertisements

/** Sorted ref names (branches and tags), HEAD handled by the caller. */
export function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v0 ref advertisement lines for a repository (without capabilities). */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
    return lines;
  }
  let first = true;
  const push = (oid: string, name: string): void => {
    if (first) {
      lines.push(pktLine(`${oid} ${name}\0${caps}`));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  };
  push(headOid ?? ZERO_OID, 'HEAD');
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    push(oid, name);
    const peeled = peelToCommit(repo, oid);
    if (peeled !== null && peeled !== oid) lines.push(pktLine(`${peeled} ${name}^{}\n`));
  }
  return lines;
}

const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative ' +
  'symref=HEAD:refs/heads/main agent=git-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0';

/** GET /info/refs for git-upload-pack, honouring the Git-Protocol header. */
export function uploadAdvertisement(repo: Repo, protocolV2: boolean): Buffer {
  if (protocolV2) {
    const parts = [
      pktLine('# service=git-upload-pack\n'),
      PKT_FLUSH,
    ];
    // The v2 advertisement proper starts after the service preamble flush in smart HTTP.
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=git-forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return Buffer.concat([...parts, body]);
  }
  const caps = UPLOAD_CAPS_V0.replace('symref=HEAD:refs/heads/main', `symref=HEAD:refs/heads/${repo.defaultBranch}`);
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    ...v0RefLines(repo, caps),
    PKT_FLUSH,
  ]);
}

/** GET /info/refs for git-receive-pack (always v0). */
export function receiveAdvertisement(repo: Repo): Buffer {
  return Buffer.concat([
    pktLine('# service=git-receive-pack\n'),
    PKT_FLUSH,
    ...v0RefLines(repo, RECEIVE_CAPS),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------- ls-refs (v2)

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Answer a v2 ls-refs command. */
export function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (args.symrefs) line += ` symref-target:${headRef}`;
      lines.push(pktLine(`${line}\n`));
    } else if (args.unborn) {
      let line = 'unborn HEAD';
      if (args.symrefs) line += ` symref-target:${headRef}`;
      lines.push(pktLine(`${line}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Wrap pack bytes in side-band-64k packets (band 1), chunked under the pkt-line limit. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1])])));
  return packets;
}

/** Answer a v2 fetch command: acknowledgments, shallow-info, then the packfile section. */
export function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    const common = args.haves.filter((oid) => repo.objects.has(oid));
    parts.push(pktLine('acknowledgments\n'));
    if (common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_FLUSH);
  }
  if (args.depth !== null || args.shallow.length > 0 || plan.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const objects = plan.send
    .map((oid) => repo.objects.get(oid))
    .filter((object): object is GitObject => object !== undefined);
  const pack = writePack(objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Answer a v0 fetch: shallow lines, one ACK or NAK, then the sideband pack. */
export function fetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.filter((oid) => repo.objects.has(oid));
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  const objects = plan.send
    .map((oid) => repo.objects.get(oid))
    .filter((object): object is GitObject => object !== undefined);
  parts.push(...sidebandPack(writePack(objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  status: number;
  body: Buffer;
}

/**
 * Apply a receive-pack request body: the command list, then the pack. Objects are stored
 * before refs move (as git does), each ref is checked on its own (fast-forward only for
 * branches), and the report goes back in side-band-64k frames when the client asked for
 * them, as report-status requires.
 */
export function receivePack(repo: Repo, body: Buffer): PushOutcome {
  // The command list is pkt-lines up to the flush; everything after it is the raw pack,
  // which is not pkt-framed, so the scan stops at the flush instead of decoding on.
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let packStart = -1;
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) return { status: 400, body: Buffer.from('error: malformed pkt-line stream\n') };
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { status: 400, body: Buffer.from('error: malformed pkt-line stream\n') };
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) return { status: 400, body: Buffer.from('error: malformed pkt-line stream\n') };
    const packet = body.subarray(offset + 4, offset + length);
    offset += length;
    let text = packet.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(text.slice(nul + 1).split(' ').filter(Boolean));
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) return { status: 400, body: Buffer.from('error: malformed ref command\n') };
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packStart >= 0 && packStart < body.length) {
    const pack = body.subarray(packStart);
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'pack objects missing or corrupt';
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    // An update with no pack at all can still be fine when every object is already here
    // (a branch created at an existing commit sends an empty pack, which the client does
    // send; a truly missing object is caught by the per-ref existence check below).
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        fail('ref does not exist');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        fail('stale info');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      fail('missing object');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== ZERO_OID) {
        fail('already exists');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      const oldCommit = peelToCommit(repo, command.oldOid);
      const newCommit = peelToCommit(repo, command.newOid);
      if (oldCommit === null || newCommit === null || !repo.isAncestor(oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const result of results) {
    reportLines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const report = Buffer.concat(reportLines);

  if (capabilities.has('side-band-64k')) {
    const packetsOut: Buffer[] = [];
    const CHUNK = PKT_MAX_PAYLOAD - 1;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      packetsOut.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
    }
    packetsOut.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(packetsOut) };
  }
  return { status: 200, body: report };
}

/** Parse a v2 command request body (command=..., delim, args, flush) into its lines. */
export function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  let packets: Packet[];
  try {
    packets = decodePackets(body);
  } catch {
    return null;
  }
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}
