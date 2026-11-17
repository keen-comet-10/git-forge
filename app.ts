// The forge's HTTP surface: git smart HTTP, the REST v3 API, the GraphQL API and the
// MCP endpoint, all served from one in-memory store. Authentication is the bearer token
// from MAKEFUN_SHOP_TOKEN; repositories belong to the token's login, and a repository
// under any other owner reads as not found.
//
// app.ts stays separate from main.ts: this file is the server; main.ts is the
// entry <-> env lifecycle and is kept as the starter ships it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  HttpError,
  createIssue,
  createPull,
  deleteContent,
  listCommits,
  mergePullSquash,
  pullFiles,
  pullMergeable,
  putContent,
  readContent,
} from './domain.ts';
import { executeGraphQL, globalId, issueGlobalId, pullGlobalId, commentGlobalId, repoGlobalId } from './graphql.ts';
import * as git from './git.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  isoTime,
  parseCommit,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

let requestCounter = 0;
const nextRequestId = (): string => `req-${(requestCounter += 1).toString(36)}`;

const expectedToken = (): string => process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function hasAnyAuthorization(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.length > 0;
}

// ---------------------------------------------------------------- plumbing

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function parseJsonBody(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asBool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

// ---------------------------------------------------------------- serializers

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', String(VIEWER_ID)),
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
    url: `https://forge.invalid/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `https://forge.invalid/${VIEWER_LOGIN}`,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}`,
    html_url: `https://forge.invalid/${repo.fullName}`,
    clone_url: `https://forge.invalid/${repo.fullName}.git`,
    git_url: `git://forge.invalid/${repo.fullName}.git`,
    ssh_url: `git@forge.invalid:${repo.fullName}.git`,
    created_at: isoTime(repo.seq),
    updated_at: isoTime(repo.seq),
    pushed_at: isoTime(repo.seq),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return {
    id: Math.abs(hash) + 1,
    node_id: globalId('Label', name),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignees: [],
    comments: issue.comments.length,
    created_at: isoTime(issue.seq),
    updated_at: isoTime(issue.seq),
    closed_at: issue.state === 'closed' ? isoTime(issue.seq) : null,
    user: userJson(),
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
    repository_url: `https://forge.invalid/api/v3/repos/${repo.fullName}`,
    labels_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(comment.id),
    body: comment.body,
    user: userJson(),
    created_at: isoTime(comment.seq),
    updated_at: isoTime(comment.seq),
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  const mergeable = pull.state === 'open' ? pullMergeable(repo, pull) === 'MERGEABLE' : null;
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged_by: pull.merged ? userJson() : null,
    mergeable,
    rebaseable: null,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: isoTime(pull.seq),
    updated_at: isoTime(pull.seq),
    closed_at: pull.state === 'closed' ? isoTime(pull.seq) : null,
    user: userJson(),
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${repo.fullName}/pulls/${pull.number}`,
    diff_url: `https://forge.invalid/${repo.fullName}/pulls/${pull.number}.diff`,
    patch_url: `https://forge.invalid/${repo.fullName}/pulls/${pull.number}.patch`,
  };
}

/** Parse a git identity line ("Name <email> ts tz") into the REST author shape. */
function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoTime(0) };
  return {
    name: match[1]!,
    email: match[2]!,
    date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** The ls-refs argument lines of a v2 request as the typed shape git.ts consumes. */
function parseLsRefsArgs(lines: readonly string[]): git.LsRefsArgs {
  const args: git.LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** The fetch argument lines (v2 section or both v0 sections) as a FetchArgs. */
function parseFetchArgs(lines: readonly string[]): git.FetchArgs {
  const args: git.FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10) || null;
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** A v0 upload-pack body is pkt-lines in two sections; collect every data line. */
function parseFetchArgsV0(body: Buffer): git.FetchArgs {
  const lines: string[] = [];
  for (const packet of git.decodePackets(body)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return parseFetchArgs(lines);
}

// ---------------------------------------------------------------- git smart HTTP

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  tail: string,
  query: URLSearchParams,
): Promise<void> {
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (req.method === 'GET' && tail === 'info/refs') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      const version2 = typeof protocol === 'string' && protocol.includes('version=2');
      sendRaw(res, 200, git.uploadAdvertisement(repo, version2), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, git.receiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'Unsupported service' });
    return;
  }
  if (req.method === 'POST' && tail === 'git-upload-pack') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    const protocol = req.headers['git-protocol'];
    const version2 = typeof protocol === 'string' && protocol.includes('version=2');
    try {
      if (version2) {
        const command = git.parseV2Command(body);
        if (command === null) {
          sendJson(res, 400, { message: 'Malformed protocol v2 request' });
          return;
        }
        if (command.command === 'ls-refs') {
          sendRaw(res, 200, git.lsRefs(repo, parseLsRefsArgs(command.args)), 'application/x-git-upload-pack-result');
          return;
        }
        if (command.command === 'fetch') {
          sendRaw(res, 200, git.fetchV2(repo, parseFetchArgs(command.args)), 'application/x-git-upload-pack-result');
          return;
        }
        sendJson(res, 400, { message: `Unsupported command ${command.command}` });
        return;
      }
      sendRaw(res, 200, git.fetchV0(repo, parseFetchArgsV0(body)), 'application/x-git-upload-pack-result');
      return;
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad upload-pack request' });
      return;
    }
  }
  if (req.method === 'POST' && tail === 'git-receive-pack') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    try {
      const outcome = git.receivePack(repo, body);
      sendRaw(res, outcome.status, outcome.body, 'application/x-git-receive-pack-result');
    } catch (err) {
      sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad receive-pack request' });
    }
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- REST v3

function requireRepo(owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function paginateList<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNumber: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNumber = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNumber };
}

function linkHeader(req: IncomingMessage, basePath: string, total: number, perPage: number, pageNumber: number): Record<string, string> {
  const host = req.headers.host ?? 'localhost';
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const urlFor = (page: number): string => `http://${host}${basePath}?per_page=${perPage}&page=${page}`;
  if (pageNumber < totalPages) {
    links.push(`<${urlFor(pageNumber + 1)}>; rel="next"`, `<${urlFor(totalPages)}>; rel="last"`);
  }
  if (pageNumber > 1) {
    links.push(`<${urlFor(pageNumber - 1)}>; rel="prev"`, `<${urlFor(1)}>; rel="first"`);
  }
  return links.length > 0 ? { link: links.join(', ') } : {};
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const rawBody = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
  const body = rawBody.length > 0 ? asRecord(parseJsonBody(rawBody.toString('utf8'))) : {};

  if (rest.length === 0) {
    if (method !== 'GET') throw new HttpError(404, 'Not Found');
    sendJson(
      res,
      200,
      {
        current_user_url: 'https://forge.invalid/api/v3/user',
        repository_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}',
        issue_search_url: 'https://forge.invalid/api/v3/search/issues?q={query}',
      },
      { 'x-oauth-scopes': 'repo, user, write:discussion' },
    );
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      github_connect: [],
      importer: [],
      packages: [],
      pages: [],
      actions: [],
      dependabot: [],
      installed_version: '3.18.0-forge',
    });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, userJson());
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = store.listRepos().map(repoJson);
      const { page, perPage, pageNumber } = paginateList(all, query);
      sendJson(res, 200, page, linkHeader(req, '/api/v3/user/repos', all.length, perPage, pageNumber));
      return;
    }
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === undefined || name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        throw new HttpError(422, 'Validation Failed: name already exists on this account');
      }
      const repo = store.createRepo(name, asString(body.description) ?? '', asBool(body.private) ?? false);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const repoName = rest[2]!;
    const tail = rest.slice(3);

    if (tail.length === 0) {
      const repo = requireRepo(owner, repoName);
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBool(body.private);
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        const defaultBranch = asString(body.default_branch);
        if (defaultBranch !== undefined && repo.refs.has(`refs/heads/${defaultBranch}`)) repo.defaultBranch = defaultBranch;
        const newName = asString(body.name);
        if (newName !== undefined && newName !== '' && newName !== repo.name) {
          store.repos.delete(repo.fullName);
          repo.name = newName;
          store.repos.set(repo.fullName, repo);
        }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendJson(res, 204, undefined);
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    const repo = requireRepo(owner, repoName);

    // ---- branches and refs
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}` },
            protected: false,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (sha === undefined) throw new HttpError(404, 'Not Found');
        sendJson(res, 200, {
          name: tail[1],
          commit: { sha, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}` },
          protected: false,
        });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({
            ref,
            node_id: globalId('Ref', ref),
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/${ref}`,
            object: { type: 'commit', sha, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
          }));
        sendJson(res, 200, refs);
        return;
      }
      if (tail.length === 2 && method === 'POST') {
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
          throw new HttpError(422, 'Validation Failed: ref and sha are required');
        }
        if (repo.objects.get(sha.toLowerCase()) === undefined) throw new HttpError(422, 'Validation Failed: sha does not exist');
        if (repo.refs.has(ref)) throw new HttpError(422, 'Validation Failed: reference already exists');
        repo.refs.set(ref, sha.toLowerCase());
        sendJson(res, 201, {
          ref,
          node_id: globalId('Ref', ref),
          url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/${ref}`,
          object: { type: 'commit', sha: sha.toLowerCase(), url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${sha.toLowerCase()}` },
        });
        return;
      }
      if (tail.length >= 3 && method === 'GET') {
        const joined = tail.slice(2).join('/');
        const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) throw new HttpError(404, 'Not Found');
        sendJson(res, 200, {
          ref,
          node_id: globalId('Ref', ref),
          url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/${ref}`,
          object: { type: 'commit', sha, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    if (tail[0] === 'git' && tail[1] === 'commits' && tail.length === 3 && method === 'GET') {
      const object = repo.objects.get(tail[2]!.toLowerCase());
      if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
      const commit = parseCommit(object.data);
      sendJson(res, 200, {
        sha: tail[2]!.toLowerCase(),
        node_id: globalId('Commit', tail[2]!.toLowerCase()),
        author: identJson(commit.author),
        committer: identJson(commit.committer),
        message: commit.message.replace(/\n$/, ''),
        tree: { sha: commit.tree, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
        parents: commit.parents.map((sha) => ({ sha, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${sha}` })),
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
        url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${tail[2]!.toLowerCase()}`,
        html_url: `https://forge.invalid/${repo.fullName}/commit/${tail[2]!.toLowerCase()}`,
      });
      return;
    }

    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const branch = query.get('sha') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(branch);
        if (tip === undefined) {
          sendJson(res, 200, []);
          return;
        }
        const commits = listCommits(repo, tip).map((entry) => {
          const object = repo.objects.get(entry.sha)!;
          const commit = parseCommit(object.data);
          return {
            sha: entry.sha,
            node_id: globalId('Commit', entry.sha),
            commit: {
              author: identJson(commit.author),
              committer: identJson(commit.committer),
              message: commit.message.replace(/\n$/, ''),
              tree: { sha: commit.tree, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
              url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${entry.sha}`,
              comment_count: 0,
            },
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${entry.sha}`,
            html_url: `https://forge.invalid/${repo.fullName}/commit/${entry.sha}`,
            comments_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${entry.sha}/comments`,
            author: null,
            committer: null,
            parents: commit.parents.map((sha) => ({
              sha,
              url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}`,
              html_url: `https://forge.invalid/${repo.fullName}/commit/${sha}`,
            })),
          };
        });
        sendJson(res, 200, commits);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const object = repo.objects.get(tail[1]!.toLowerCase());
        if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
        const commit = parseCommit(object.data);
        sendJson(res, 200, {
          sha: tail[1]!.toLowerCase(),
          node_id: globalId('Commit', tail[1]!.toLowerCase()),
          commit: {
            author: identJson(commit.author),
            committer: identJson(commit.committer),
            message: commit.message.replace(/\n$/, ''),
            tree: { sha: commit.tree, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${tail[1]!.toLowerCase()}`,
            comment_count: 0,
          },
          url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${tail[1]!.toLowerCase()}`,
          html_url: `https://forge.invalid/${repo.fullName}/commit/${tail[1]!.toLowerCase()}`,
          author: null,
          committer: null,
          parents: commit.parents.map((sha) => ({
            sha,
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}`,
            html_url: `https://forge.invalid/${repo.fullName}/commit/${sha}`,
          })),
        });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    // ---- contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        const found = readContent(repo, path, query.get('ref') ?? undefined);
        if (found === null) throw new HttpError(404, 'Not Found');
        if (found.kind === 'file') {
          const name = path.split('/').pop() ?? path;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: found.data.length,
            name,
            path,
            content: found.data.toString('base64').replace(/(.{60})/g, '$1\n'),
            sha: found.oid,
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/contents/${path}`,
            html_url: `https://forge.invalid/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
            git_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/blobs/${found.oid}`,
            download_url: `https://forge.invalid/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
            _links: {},
          });
          return;
        }
        sendJson(
          res,
          200,
          found.entries.map((entry) => ({
            type: entry.type,
            size: entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
            html_url: `https://forge.invalid/${repo.fullName}/blob/${repo.defaultBranch}/${entry.path}`,
            git_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/blobs/${entry.sha}`,
            download_url: null,
            _links: {},
          })),
        );
        return;
      }
      if (method === 'PUT') {
        const message = asString(body.message);
        const contentBase64 = asString(body.content);
        if (message === undefined || contentBase64 === undefined) {
          throw new HttpError(422, 'Validation Failed: message and content are required');
        }
        const content = Buffer.from(contentBase64.replace(/\s/g, ''), 'base64');
        const result = putContent(store, repo, {
          path,
          content,
          message,
          branch: asString(body.branch),
          sha: asString(body.sha),
        });
        const commit = parseCommit(repo.objects.get(result.commitSha)!.data);
        sendJson(res, result.created ? 201 : 200, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobSha,
            encoding: 'base64',
            size: content.length,
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/contents/${path}`,
            html_url: `https://forge.invalid/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
            git_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/blobs/${result.blobSha}`,
            download_url: `https://forge.invalid/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
            type: 'file',
            _links: {},
          },
          commit: {
            sha: result.commitSha,
            node_id: globalId('Commit', result.commitSha),
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${result.commitSha}`,
            html_url: `https://forge.invalid/${repo.fullName}/commit/${result.commitSha}`,
            author: identJson(commit.author),
            committer: identJson(commit.committer),
            message: commit.message.replace(/\n$/, ''),
            tree: { sha: commit.tree, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
            parents: commit.parents.map((sha) => ({
              sha,
              url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}`,
              html_url: `https://forge.invalid/${repo.fullName}/commit/${sha}`,
            })),
          },
        });
        return;
      }
      if (method === 'DELETE') {
        const message = asString(body.message);
        if (message === undefined) throw new HttpError(422, 'Validation Failed: message is required');
        const result = deleteContent(store, repo, {
          path,
          message,
          branch: asString(body.branch),
          sha: asString(body.sha),
        });
        const commit = parseCommit(repo.objects.get(result.commitSha)!.data);
        sendJson(res, 200, {
          content: null,
          commit: {
            sha: result.commitSha,
            node_id: globalId('Commit', result.commitSha),
            url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/commits/${result.commitSha}`,
            html_url: `https://forge.invalid/${repo.fullName}/commit/${result.commitSha}`,
            author: identJson(commit.author),
            committer: identJson(commit.committer),
            message: commit.message.replace(/\n$/, ''),
            tree: { sha: commit.tree, url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
            parents: commit.parents.map((sha) => ({
              sha,
              url: `https://forge.invalid/api/v3/repos/${repo.fullName}/commits/${sha}`,
              html_url: `https://forge.invalid/${repo.fullName}/commit/${sha}`,
            })),
          },
        });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    // ---- labels
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        sendJson(res, 200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        const name = asString(body.name);
        if (name === undefined || name === '') throw new HttpError(422, 'Validation Failed: name is required');
        if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: name already exists');
        repo.labels.set(name, {
          name,
          color: (asString(body.color) ?? 'ededed').replace(/^#/, ''),
          description: asString(body.description) ?? '',
        });
        sendJson(res, 201, labelJson(repo, name));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    // ---- issues
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        if (query.get('direction') === 'desc') issues.reverse();
        sendJson(res, 200, issues.map((issue) => issueJson(repo, issue)));
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        const title = asString(body.title);
        if (title === undefined || title === '') throw new HttpError(422, 'Validation Failed: title is required');
        const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
        const issue = createIssue(store, repo, { title, body: asString(body.body) ?? '', labels });
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      const number = Number.parseInt(tail[1] ?? '', 10);
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (tail.length === 2) {
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const issueBody = asString(body.body);
          if (issueBody !== undefined) issue.body = issueBody;
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((label): label is string => typeof label === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist`);
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        throw new HttpError(404, 'Not Found');
      }
      if (issue === undefined) throw new HttpError(404, 'Not Found');
      if (tail[2] === 'comments') {
        if (tail.length === 3 && method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return;
        }
        if (tail.length === 3 && method === 'POST') {
          const text = asString(body.body);
          if (text === undefined) throw new HttpError(422, 'Validation Failed: body is required');
          const comment = { id: store.nextCommentIdValue(), body: text, seq: store.nextSeq() };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
        throw new HttpError(404, 'Not Found');
      }
      if (tail[2] === 'labels') {
        if (tail.length === 3 && method === 'GET') {
          sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)));
          return;
        }
        if (tail.length === 3 && method === 'POST') {
          const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) throw new HttpError(404, 'Not Found');
          }
          for (const label of labels) {
            if (!issue.labels.includes(label)) issue.labels.push(label);
          }
          sendJson(res, 200, issue.labels.map((name) => labelJson(repo, name)));
          return;
        }
        if (tail.length === 4 && method === 'DELETE') {
          const name = tail[3]!;
          issue.labels = issue.labels.filter((label) => label !== name);
          sendJson(res, 200, issue.labels.map((label) => labelJson(repo, label)));
          return;
        }
        throw new HttpError(404, 'Not Found');
      }
      throw new HttpError(404, 'Not Found');
    }

    // ---- pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open' && !pull.merged);
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed' || pull.merged);
        sendJson(res, 200, pulls.map((pull) => pullJson(repo, pull)));
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        const title = asString(body.title);
        const headRaw = asString(body.head);
        const base = asString(body.base);
        if (title === undefined || headRaw === undefined || base === undefined) {
          throw new HttpError(422, 'Validation Failed: title, head and base are required');
        }
        const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
        const pull = createPull(store, repo, { title, body: asString(body.body) ?? '', head, base });
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      const number = Number.parseInt(tail[1] ?? '', 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new HttpError(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (method === 'PATCH') {
          const title = asString(body.title);
          if (title !== undefined) pull.title = title;
          const pullBody = asString(body.body);
          if (pullBody !== undefined) pull.body = pullBody;
          const state = asString(body.state);
          if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
          const base = asString(body.base);
          if (base !== undefined && repo.refs.has(`refs/heads/${base}`)) pull.baseRef = base;
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        throw new HttpError(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        sendJson(
          res,
          200,
          pullFiles(repo, pull).map((file) => {
            const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
            const flat = headTip === undefined ? undefined : repo.flattenTree(headTip).get(file.filename);
            return {
              sha: flat?.oid ?? ZERO_OID,
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              blob_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/git/blobs/${flat?.oid ?? ZERO_OID}`,
              raw_url: `https://forge.invalid/${repo.fullName}/raw/${pull.headRef}/${file.filename}`,
              contents_url: `https://forge.invalid/api/v3/repos/${repo.fullName}/contents/${file.filename}?ref=${pull.headRef}`,
            };
          }),
        );
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull.merged) {
          sendJson(res, 200, { sha: pull.mergeCommitSha ?? ZERO_OID, merged: true, message: 'Pull Request successfully merged' });
          return;
        }
        if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
        const result = mergePullSquash(store, repo, pull);
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const text = (await readBody(req)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    const record = asRecord(entry);
    const query = asString(record.query) ?? '';
    const variables = asRecord(record.variables);
    const operationName = asString(record.operationName);
    return executeGraphQL(query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: readonly Record<string, unknown>[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    isError,
  };
  if (!isError && value !== null && typeof value === 'object') out.structuredContent = value;
  return out;
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = MCP_TOOLS.find((tool) => tool.name === name)?.inputSchema as { required?: string[] } | undefined;
  if (schema === undefined) {
    const error = new Error(`Unknown tool: ${name}`) as Error & { code?: number };
    error.code = -32602;
    throw error;
  }
  for (const field of schema.required ?? []) {
    if (args[field] === undefined || args[field] === null || args[field] === '') {
      const error = new Error(`Missing required argument: ${field}`) as Error & { code?: number };
      error.code = -32602;
      throw error;
    }
  }
  const needRepo = (): Repo => {
    const repo = store.getRepo(asString(args.owner) ?? '', asString(args.repo) ?? '');
    if (repo === undefined) throw new Error(`Repository not found: ${asString(args.owner)}/${asString(args.repo)}`);
    return repo;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name)!;
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) throw new Error(`Repository ${repoName} already exists`);
      const repo = store.createRepo(repoName, asString(args.description) ?? '', asBool(args.private) ?? false);
      return toolResult(repoJson(repo));
    }
    case 'get_repo':
      return toolResult(repoJson(needRepo()));
    case 'create_issue': {
      const repo = needRepo();
      const issue = createIssue(store, repo, { title: asString(args.title)!, body: asString(args.body) ?? '' });
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo();
      const state = asString(args.state) ?? 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = needRepo();
      const pull = createPull(store, repo, {
        title: asString(args.title)!,
        body: asString(args.body) ?? '',
        head: asString(args.head)!,
        base: asString(args.base)!,
      });
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo();
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error(`Pull request ${number} not found`);
      if (!pull.merged) {
        if (pull.state !== 'open') throw new Error('Pull Request is not mergeable');
        mergePullSquash(store, repo, pull);
      }
      return toolResult(pullJson(repo, pull));
    }
    default: {
      const error = new Error(`Unknown tool: ${name}`) as Error & { code?: number };
      error.code = -32602;
      throw error;
    }
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  if (!hasAnyAuthorization(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const text = (await readBody(req)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const handleOne = (entry: unknown): Record<string, unknown> | null => {
    const request = asRecord(entry);
    const hasId = 'id' in request;
    const id = request.id;
    const method = asString(request.method) ?? '';
    const params = asRecord(request.params);
    const result = (value: unknown): Record<string, unknown> | null =>
      hasId ? { jsonrpc: '2.0', id: id ?? null, result: value } : null;
    const failure = (code: number, message: string): Record<string, unknown> | null =>
      hasId ? { jsonrpc: '2.0', id: id ?? null, error: { code, message } } : null;
    switch (method) {
      case 'server/discover':
        return result({
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: { name: 'git-forge', version: '1.0.0' },
          protocolVersion: '2026-07-28',
        });
      case 'initialize':
        return result({
          protocolVersion: asString(params.protocolVersion) ?? '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'git-forge', version: '1.0.0' },
        });
      case 'ping':
        return result({});
      case 'tools/list':
        return result({ tools: MCP_TOOLS });
      case 'tools/call': {
        const toolName = asString(params.name);
        if (toolName === undefined) return failure(-32602, 'Missing tool name');
        try {
          return result(callMcpTool(toolName, asRecord(params.arguments)));
        } catch (err) {
          const code = (err as { code?: number }).code;
          if (typeof code === 'number') return failure(code, err instanceof Error ? err.message : 'Invalid params');
          return result(toolResult(err instanceof Error ? err.message : 'Tool failed', true));
        }
      }
      case 'resources/list':
        return result({ resources: [] });
      case 'resources/templates/list':
        return result({ resourceTemplates: [] });
      case 'prompts/list':
        return result({ prompts: [] });
      default:
        if (method.startsWith('notifications/')) return null;
        return failure(-32601, `Method not found: ${method}`);
    }
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map(handleOne).filter((entry) => entry !== null);
    if (results.length === 0) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, 200, results);
    return;
  }
  const single = handleOne(parsed);
  if (single === null) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, 200, single);
}

// ---------------------------------------------------------------- top level

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/api/graphql') {
      await handleGraphQL(req, res);
      return;
    }
    if (path === '/mcp') {
      await handleMcp(req, res);
      return;
    }
    const segments = path
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Unauthorized' });
        return;
      }
      await handleRest(req, res, segments, url.searchParams);
      return;
    }
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      await handleGit(req, res, decodeURIComponent(gitMatch[1]!), decodeURIComponent(gitMatch[2]!), gitMatch[3]!, url.searchParams);
      return;
    }
    if (path === '/') {
      sendJson(res, 200, { ok: true, service: 'git-forge' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
}
