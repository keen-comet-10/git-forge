// The forge's domain operations, shared by the REST, GraphQL and MCP surfaces so every
// surface acts on the same store and reads back the same objects: contents commits on
// branches, issues, pull requests, three-way tree merges and squash merges.

import {
  ZERO_OID,
  buildCommit,
  gitIdent,
  isoTime,
  parseCommit,
  store,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

/** An error that maps onto an HTTP status on the REST surface. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- contents

export interface ContentWrite {
  commitSha: string;
  blobSha: string;
  created: boolean;
}

/** The branch ref a contents call names, creating the ref at the default tip when new. */
function branchRefForWrite(repo: Repo, branch: string | undefined): string {
  const name = branch ?? repo.defaultBranch;
  const ref = `refs/heads/${name}`;
  if (!repo.refs.has(ref)) {
    const fallback = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (fallback !== undefined) repo.refs.set(ref, fallback);
  }
  return ref;
}

/** Create or update one file on a branch, as a new commit; 409 on a stale sha. */
export function putContent(
  forge: Store,
  repo: Repo,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentWrite {
  const ref = branchRefForWrite(repo, input.branch);
  const tip = repo.refs.get(ref);
  const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : repo.flattenTree(tip);
  const existing = files.get(input.path);
  if (existing !== undefined && input.sha !== undefined && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
    throw new HttpError(409, `The sha provided for ${input.path} does not match the current blob`);
  }
  const blobSha = repo.putObject('blob', input.content);
  files.set(input.path, { oid: blobSha, mode: existing?.mode ?? '100644' });
  const tree = repo.buildTreeFromFiles(files);
  const seq = forge.nextSeq();
  const commitSha = repo.putObject(
    'commit',
    buildCommit({
      tree,
      parents: tip === undefined ? [] : [tip],
      author: gitIdent(seq),
      committer: gitIdent(seq),
      message: input.message,
    }),
  );
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha, created: existing === undefined };
}

/** Delete one file on a branch, as a new commit; 404 when the file is absent. */
export function deleteContent(
  forge: Store,
  repo: Repo,
  input: { path: string; message: string; branch?: string; sha?: string },
): { commitSha: string } {
  const name = input.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${name}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) throw new HttpError(404, 'Not Found');
  const files = repo.flattenTree(tip);
  const existing = files.get(input.path);
  if (existing === undefined) throw new HttpError(404, 'Not Found');
  if (input.sha !== undefined && input.sha.toLowerCase() !== existing.oid.toLowerCase()) {
    throw new HttpError(409, `The sha provided for ${input.path} does not match the current blob`);
  }
  files.delete(input.path);
  const tree = repo.buildTreeFromFiles(files);
  const seq = forge.nextSeq();
  const commitSha = repo.putObject(
    'commit',
    buildCommit({ tree, parents: [tip], author: gitIdent(seq), committer: gitIdent(seq), message: input.message }),
  );
  repo.refs.set(ref, commitSha);
  return { commitSha };
}

/** Read one path at a ref: a file, a directory listing, or null when absent. */
export function readContent(
  repo: Repo,
  path: string,
  ref: string | undefined,
): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> } | null {
  const refName = ref ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(refName) ?? (ref !== undefined && /^[0-9a-f]{40}$/.test(ref) ? ref : undefined);
  if (tip === undefined) return null;
  const files = repo.flattenTree(tip);
  if (path === '' || path === '/') {
    return { kind: 'dir', entries: dirEntries(files, '') };
  }
  const file = files.get(path);
  if (file !== undefined) {
    const object = repo.objects.get(file.oid);
    if (object === undefined) return null;
    return { kind: 'file', oid: file.oid, data: object.data };
  }
  const prefix = `${path}/`;
  const hasChildren = [...files.keys()].some((key) => key.startsWith(prefix));
  if (hasChildren) return { kind: 'dir', entries: dirEntries(files, path) };
  return null;
}

function dirEntries(
  files: Map<string, { oid: string; mode: string }>,
  dir: string,
): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { name: rest, path, type: 'file', sha: file.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { name, path: `${prefix}${name}`, type: 'dir', sha: ZERO_OID });
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------- issues

/** Create an issue; 422 when it names a label the repository does not hold. */
export function createIssue(
  forge: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist`);
  }
  const issue: Issue = {
    kind: 'issue',
    id: forge.nextIssueIdValue(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: forge.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

// ---------------------------------------------------------------- pull requests

/** Create a pull request from a head branch into a base branch. */
export function createPull(
  forge: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull {
  const headTip = repo.refs.get(`refs/heads/${input.head}`);
  if (headTip === undefined) throw new HttpError(422, `Validation Failed: head ref ${input.head} does not exist`);
  const baseTip = repo.refs.get(`refs/heads/${input.base}`);
  if (baseTip === undefined) throw new HttpError(422, `Validation Failed: base ref ${input.base} does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      throw new HttpError(422, 'Validation Failed: a pull request already exists for this branch');
    }
  }
  const pull: Pull = {
    kind: 'pull',
    id: forge.nextIssueIdValue(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    seq: forge.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** The files a pull request changes: the diff between its merge base and its head tip. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const mergeBase = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const from = repo.flattenTree(mergeBase);
  const to = repo.flattenTree(headTip);
  const files: PullFile[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.oid === after?.oid) continue;
    const beforeData = before === undefined ? null : (repo.objects.get(before.oid)?.data ?? null);
    const afterData = after === undefined ? null : (repo.objects.get(after.oid)?.data ?? null);
    const additions = afterData === null ? 0 : lineCount(afterData);
    const deletions = beforeData === null ? 0 : lineCount(beforeData);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: before === undefined ? additions : after === undefined ? 0 : additions,
      deletions: after === undefined ? deletions : before === undefined ? 0 : deletions,
      changes: (before === undefined ? additions : after === undefined ? 0 : additions) + (after === undefined ? deletions : before === undefined ? 0 : deletions),
    });
  }
  return files;
}

/** A three-way merge of two tips over their merge base: the merged files, or null on conflict. */
export function mergeTrees(
  repo: Repo,
  baseTip: string,
  headTip: string,
): Map<string, { oid: string; mode: string }> | null {
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const baseFiles = repo.flattenTree(baseTip);
  const headFiles = repo.flattenTree(headTip);
  const originFiles = mergeBase === null ? new Map<string, { oid: string; mode: string }>() : repo.flattenTree(mergeBase);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...originFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const origin = originFiles.get(path)?.oid;
    const base = baseFiles.get(path)?.oid;
    const head = headFiles.get(path)?.oid;
    if (base === head) {
      const keep = baseFiles.get(path) ?? headFiles.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else if (origin === base) {
      const keep = headFiles.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else if (origin === head) {
      const keep = baseFiles.get(path);
      if (keep !== undefined) merged.set(path, keep);
    } else {
      return null;
    }
  }
  return merged;
}

/** Whether a pull request can merge cleanly into its (current) base branch. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.state !== 'open') return 'MERGEABLE';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
  if (repo.isAncestor(headTip, baseTip)) return 'MERGEABLE';
  return mergeTrees(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge a pull request: one commit on the base branch carrying the merged tree,
 * the pull closed as merged. 405 when the merge conflicts.
 */
export function mergePullSquash(forge: Store, repo: Repo, pull: Pull): { sha: string } {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
  let sha: string;
  if (repo.isAncestor(headTip, baseTip)) {
    sha = baseTip;
  } else {
    const merged = mergeTrees(repo, baseTip, headTip);
    if (merged === null) throw new HttpError(405, 'Pull Request is not mergeable');
    const tree = repo.buildTreeFromFiles(merged);
    const seq = forge.nextSeq();
    sha = repo.putObject(
      'commit',
      buildCommit({
        tree,
        parents: [baseTip],
        author: gitIdent(seq),
        committer: gitIdent(seq),
        message: `${pull.title} (#${pull.number})`,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoTime(forge.nextSeq());
  return { sha };
}

/** The commit list for a branch: newest first, following parents from the tip. */
export function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; tree: string }> {
  const out: Array<{ sha: string; message: string; tree: string }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message.replace(/\n$/, ''), tree: commit.tree });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

export { store };
