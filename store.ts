// The forge's own store: git objects, refs, repositories, issues, pull requests, labels and
// comments, all in memory in this one process. Nothing here touches the filesystem, the clock
// or a random source: a logical sequence numbers every creation, and timestamps derive from
// it, so two runs that take the same requests reach the same state.

import { createHash } from 'node:crypto';

/** The one user the trial's bearer token belongs to (the suite's seeded viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 of a git object, exactly as git computes it: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree entry order: by name, with directories sorting as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Parse an annotated tag object's target. */
export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Peel an object id through tag objects until a non-tag object (or a missing object). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTagTarget(object.data).object;
  }
  return null;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;
  readonly seq: number;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = 'main';
    this.seq = seq;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** Store an object and answer its id (idempotent). */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** The flattened path -> blob oid map of a commit's tree (empty for a missing commit). */
  flattenTree(commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = this.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
        else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Build (and store) a tree from a flattened path -> blob oid map; answers the root tree id. */
  buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index]!;
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment)!;
      }
      node.files.set(segments[segments.length - 1]!, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Every commit reachable from `tip`, tip first (breadth-first over parents). */
  reachableCommits(tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return order;
  }

  /** Whether `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The best common ancestor of two commits, or null when they share none. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set(this.reachableCommits(a));
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }
}

/** The whole forge: every repository the viewer owns, plus the id and sequence counters. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private sequence = 0;

  /** The next logical sequence number (creation order, used for sorting and timestamps). */
  nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  nextRepoIdValue(): number {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    return id;
  }

  nextIssueIdValue(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoIdValue(), VIEWER_LOGIN, name, description, isPrivate, this.nextSeq());
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER_LOGIN) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}

/** The one store this process serves. */
export const store = new Store();

/** A deterministic ISO timestamp for a logical sequence number (2025-01-01 + seq seconds). */
export function isoTime(seq: number): string {
  return new Date(1_735_689_600_000 + seq * 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A git identity line for a logical sequence number. */
export function gitIdent(seq: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${1_735_689_600 + seq} +0000`;
}
