// A small GraphQL executor for the v4 documents gh and github-mcp-server send: queries,
// mutations, variables, aliases, inline fragments, input objects and enum lists, Relay
// global ids and cursor connections, and __type introspection. It is deliberately not a
// general GraphQL server: it parses the document grammar those clients use and resolves
// it against the same store the REST and MCP surfaces serve.

import { createPull, createIssue, mergePullSquash, pullFiles, pullMergeable } from './domain.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  isoTime,
  store,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- global ids

/** Relay global ids: base64 of "<Type>:<key>", opaque and stable across reads. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export const repoGlobalId = (repo: Repo): string => globalId('Repository', String(repo.id));
export const issueGlobalId = (repo: Repo, issue: Issue): string =>
  globalId('Issue', `${repo.id}:${issue.number}`);
export const pullGlobalId = (repo: Repo, pull: Pull): string =>
  globalId('PullRequest', `${repo.id}:${pull.number}`);
export const commentGlobalId = (id: number): string => globalId('IssueComment', String(id));

// ---------------------------------------------------------------- schema (for validation and introspection)

export const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'description', 'url',
    'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'labels', 'comments', 'author',
    'createdAt', 'updatedAt', 'closedAt', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'commits', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'url', 'author', 'repository',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'committedDate'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'databaseId', 'body', 'url', 'createdAt', 'updatedAt', 'author'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
});

export const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'PULL_REQUEST', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileStatus: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED'],
});

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end === -1) throw new ParseError('unterminated block string');
        tokens.push(JSON.stringify(source.slice(index + 3, end)));
        index = end + 3;
        continue;
      }
      let end = index + 1;
      let text = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\') {
          text += source[end] + (source[end + 1] ?? '');
          end += 2;
        } else {
          text += source[end];
          end += 1;
        }
      }
      if (end >= source.length) throw new ParseError('unterminated string');
      tokens.push(`"${text}"`);
      index = end + 1;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(char)) {
      if (source.startsWith('...', index)) {
        tokens.push('...');
        index += 3;
      } else {
        tokens.push(char);
        index += 1;
      }
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(index));
    if (match === null) throw new ParseError(`unexpected character ${JSON.stringify(char)}`);
    tokens.push(match[0]);
    index += match[0].length;
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.position += 1;
    return token;
  }

  private expect(token: string): void {
    const found = this.next();
    if (found !== token) throw new ParseError(`expected ${token}, found ${found}`);
  }

  private skipBalanced(): void {
    // Skip a parenthesised group (variable definitions, directive arguments).
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.position < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        let name: string | null = null;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken !== '(' && nextToken !== '{' && nextToken !== '@') name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({
          type: token === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
        });
      } else if (token === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.next(); // fragment name
        this.next(); // 'on'
        this.next(); // type condition
        this.parseSelectionSet();
      } else {
        throw new ParseError(`unexpected token ${token}`);
      }
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        if (this.peek() === '(') this.skipBalanced();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      // A fragment spread: the suite's documents use none; treat as an empty fragment.
      this.next();
      return { kind: 'inlineFragment', typeCondition: null, selection: [] };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------- execution

interface GqlError {
  message: string;
}

/** A resolved value tagged with its GraphQL type, so field resolution stays typed. */
interface GqlObject {
  $type: string;
  $value: unknown;
}

const obj = (type: string, value: unknown): GqlObject => ({ $type: type, $value: value });

interface ExecContext {
  forge: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function valueOf(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => valueOf(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx);
  return out;
}

const cursorFor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64');

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

interface Connection {
  items: GqlObject[];
  total: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  cursors: Array<string | null>;
}

function paginate<T>(
  all: readonly T[],
  args: Record<string, unknown>,
  numberOf: (item: T) => number,
  wrap: (item: T) => GqlObject,
): Connection {
  let startIndex = 0;
  const after = numberFromCursor(args.after);
  if (after !== null) {
    const found = all.findIndex((item) => numberOf(item) === after);
    if (found >= 0) startIndex = found + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : all.length;
  const slice = all.slice(startIndex, startIndex + first);
  return {
    items: slice.map(wrap),
    total: all.length,
    hasNextPage: startIndex + slice.length < all.length,
    endCursor: slice.length > 0 ? cursorFor(numberOf(slice[slice.length - 1]!)) : null,
    startCursor: slice.length > 0 ? cursorFor(numberOf(slice[0]!)) : null,
    cursors: slice.map((item) => cursorFor(numberOf(item))),
  };
}

function repoFromGlobalId(forge: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return forge.findRepoById(Number.parseInt(decoded.key, 10)) ?? null;
}

function issueFromGlobalId(forge: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = forge.findRepoById(Number.parseInt(repoId ?? '', 10));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number.parseInt(number ?? '', 10));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(forge: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = forge.findRepoById(Number.parseInt(repoId ?? '', 10));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number.parseInt(number ?? '', 10));
  return pull === undefined ? null : { repo, pull };
}

/** Resolve one field of one object; returns a scalar, a GqlObject, a list, or null. */
function resolveField(
  source: GqlObject,
  field: FieldNode,
  ctx: ExecContext,
): unknown {
  const args = argsOf(field, ctx);
  const type = source.$type;
  const value = source.$value as never;
  switch (type) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return obj('User', { login: VIEWER_LOGIN });
        case 'repository': {
          const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === undefined ? null : obj('Repository', repo);
        }
        case 'node': {
          const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
          if (decoded === null) return null;
          if (decoded.type === 'Repository') {
            const repo = ctx.forge.findRepoById(Number.parseInt(decoded.key, 10));
            return repo === undefined ? null : obj('Repository', repo);
          }
          if (decoded.type === 'Issue') {
            const found = issueFromGlobalId(ctx.forge, args.id);
            return found === null ? null : obj('Issue', found);
          }
          if (decoded.type === 'PullRequest') {
            const found = pullFromGlobalId(ctx.forge, args.id);
            return found === null ? null : obj('PullRequest', found);
          }
          if (decoded.type === 'User') return obj('User', { login: VIEWER_LOGIN });
          return null;
        }
        case '__type': {
          const name = String(args.name ?? '');
          if (TYPE_FIELDS[name] !== undefined) {
            return obj('__Type', { name, kind: 'OBJECT', fields: TYPE_FIELDS[name] });
          }
          if (ENUM_VALUES[name] !== undefined) {
            return obj('__Type', { name, kind: 'ENUM', enumValues: ENUM_VALUES[name] });
          }
          return null;
        }
        case '__schema':
          return obj('__Schema', {});
        default:
          return undefined;
      }
    }
    case 'Mutation': {
      switch (field.name) {
        case 'createIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromGlobalId(ctx.forge, input.repositoryId);
          if (repo === null) throw new Error('repository not found for createIssue');
          const issue = createIssue(ctx.forge, repo, {
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
          });
          return obj('CreateIssuePayload', { repo, issue });
        }
        case 'closeIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromGlobalId(ctx.forge, input.issueId);
          if (found === null) throw new Error('issue not found for closeIssue');
          found.issue.state = 'closed';
          return obj('CloseIssuePayload', found);
        }
        case 'createPullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromGlobalId(ctx.forge, input.repositoryId);
          if (repo === null) throw new Error('repository not found for createPullRequest');
          const pull = createPull(ctx.forge, repo, {
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? ''),
          });
          return obj('CreatePullRequestPayload', { repo, pull });
        }
        case 'mergePullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = pullFromGlobalId(ctx.forge, input.pullRequestId);
          if (found === null) throw new Error('pull request not found for mergePullRequest');
          mergePullSquash(ctx.forge, found.repo, found.pull);
          return obj('MergePullRequestPayload', found);
        }
        case 'addComment': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromGlobalId(ctx.forge, input.subjectId);
          if (found === null) throw new Error('subject not found for addComment');
          const comment = {
            id: ctx.forge.nextCommentIdValue(),
            body: String(input.body ?? ''),
            seq: ctx.forge.nextSeq(),
          };
          found.issue.comments.push(comment);
          return obj('AddCommentPayload', { repo: found.repo, issue: found.issue, comment });
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      const user = value as { login: string };
      switch (field.name) {
        case 'login':
          return user.login;
        case 'id':
          return globalId('User', String(VIEWER_ID));
        case 'name':
          return 'ada iversen';
        case 'email':
          return 'adaiversen@example.invalid';
        default:
          return undefined;
      }
    }
    case 'Repository': {
      const repo = value as Repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return obj('User', { login: repo.owner });
        case 'defaultBranchRef': {
          const ref = `refs/heads/${repo.defaultBranch}`;
          return repo.refs.has(ref) ? obj('Ref', { name: repo.defaultBranch }) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasProjectsEnabled':
          return false;
        case 'hasWikiEnabled':
          return false;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'createdAt':
          return isoTime(repo.seq);
        case 'updatedAt':
          return isoTime(repo.seq);
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : obj('Issue', { repo, issue });
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null && states.length > 0) {
            const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          if (orderBy !== null && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
            issues.sort((a, b) => b.seq - a.seq || b.number - a.number);
          } else if (orderBy !== null && orderBy.direction === 'DESC') {
            issues.sort((a, b) => b.seq - a.seq || b.number - a.number);
          } else {
            issues.sort((a, b) => a.seq - b.seq || a.number - b.number);
          }
          const connection = paginate(issues, args, (issue) => issue.number, (issue) => obj('Issue', { repo, issue }));
          return obj('IssueConnection', connection);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : obj('PullRequest', { repo, pull });
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null && states.length > 0) {
            pulls = pulls.filter((pull) => {
              const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
              return states.includes(state);
            });
          }
          pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
          const connection = paginate(pulls, args, (pull) => pull.number, (pull) => obj('PullRequest', { repo, pull }));
          return obj('PullRequestConnection', connection);
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'createdAt':
          return isoTime(issue.seq);
        case 'updatedAt':
          return isoTime(issue.seq);
        case 'closedAt':
          return issue.state === 'closed' ? isoTime(issue.seq) : null;
        case 'repository':
          return obj('Repository', repo);
        case 'author':
          return obj('User', { login: VIEWER_LOGIN });
        case 'labels': {
          const nodes = issue.labels.map((name) => obj('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' }));
          return obj('LabelConnection', { items: nodes, total: nodes.length, hasNextPage: false, endCursor: null, startCursor: null, cursors: [] });
        }
        case 'comments': {
          const connection = paginate(
            issue.comments,
            args,
            (comment) => comment.id,
            (comment) => obj('IssueComment', comment),
          );
          return obj('IssueCommentConnection', connection);
        }
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.state === 'open' ? pullMergeable(repo, pull) : 'UNKNOWN';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'createdAt':
          return isoTime(pull.seq);
        case 'updatedAt':
          return isoTime(pull.seq);
        case 'mergedAt':
          return pull.mergedAt;
        case 'repository':
          return obj('Repository', repo);
        case 'author':
          return obj('User', { login: VIEWER_LOGIN });
        case 'files': {
          const files = pullFiles(repo, pull).map((file) => obj('PullRequestChangedFile', file));
          const connection = paginate(files, args, (_file, index) => index, (file) => file);
          return obj('PullRequestChangedFileConnection', connection);
        }
        case 'mergeCommit': {
          return pull.mergeCommitSha === null ? null : obj('Commit', { oid: pull.mergeCommitSha });
        }
        default:
          return undefined;
      }
    }
    case 'Ref': {
      const ref = value as { name: string };
      return field.name === 'name' ? ref.name : field.name === 'prefix' ? 'refs/heads/' : undefined;
    }
    case 'Commit': {
      const commit = value as { oid: string };
      if (field.name === 'oid') return commit.oid;
      if (field.name === 'id') return globalId('Commit', commit.oid);
      return undefined;
    }
    case 'PullRequestChangedFile': {
      const file = value as { filename: string; additions: number; deletions: number; status: string };
      switch (field.name) {
        case 'path':
          return file.filename;
        case 'additions':
          return file.additions;
        case 'deletions':
          return file.deletions;
        case 'changeType':
          return file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
        default:
          return undefined;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      const connection = value as Connection;
      switch (field.name) {
        case 'nodes':
          return connection.items;
        case 'totalCount':
          return connection.total;
        case 'pageInfo':
          return obj('PageInfo', connection);
        case 'edges':
          return connection.items.map((item, index) => obj('Edge', { node: item, cursor: connection.cursors[index] ?? null }));
        default:
          return undefined;
      }
    }
    case 'Edge': {
      const edge = value as { node: GqlObject; cursor: string | null };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      return undefined;
    }
    case 'PageInfo': {
      const info = value as Connection;
      switch (field.name) {
        case 'hasNextPage':
          return info.hasNextPage;
        case 'hasPreviousPage':
          return false;
        case 'startCursor':
          return info.startCursor;
        case 'endCursor':
          return info.endCursor;
        default:
          return undefined;
      }
    }
    case 'CreateIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (field.name === 'issue') return obj('Issue', payload);
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'CloseIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (field.name === 'issue') return obj('Issue', payload);
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      const payload = value as { repo: Repo; pull: Pull };
      if (field.name === 'pullRequest') return obj('PullRequest', payload);
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'MergePullRequestPayload': {
      const payload = value as { repo: Repo; pull: Pull };
      if (field.name === 'pullRequest') return obj('PullRequest', payload);
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'AddCommentPayload': {
      const payload = value as { repo: Repo; issue: Issue; comment: { id: number; body: string; seq: number } };
      if (field.name === 'commentEdge') return obj('CommentEdge', { node: obj('IssueComment', payload.comment), cursor: null });
      if (field.name === 'subject') return obj('Issue', { repo: payload.repo, issue: payload.issue });
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'CommentEdge': {
      const edge = value as { node: GqlObject; cursor: string | null };
      if (field.name === 'node') return edge.node;
      if (field.name === 'cursor') return edge.cursor;
      return undefined;
    }
    case 'IssueComment': {
      const comment = value as { id: number; body: string; seq: number };
      switch (field.name) {
        case 'id':
          return commentGlobalId(comment.id);
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'createdAt':
          return isoTime(comment.seq);
        case 'updatedAt':
          return isoTime(comment.seq);
        case 'author':
          return obj('User', { login: VIEWER_LOGIN });
        default:
          return undefined;
      }
    }
    case 'Label': {
      const label = value as { name: string; color: string };
      switch (field.name) {
        case 'id':
          return globalId('Label', label.name);
        case 'name':
          return label.name;
        case 'color':
          return label.color;
        case 'description':
          return null;
        default:
          return undefined;
      }
    }
    case '__Type': {
      const typeInfo = value as { name: string; kind: string; fields?: readonly string[]; enumValues?: readonly string[] };
      switch (field.name) {
        case 'name':
          return typeInfo.name;
        case 'kind':
          return typeInfo.kind;
        case 'fields':
          return typeInfo.fields === undefined ? null : typeInfo.fields.map((name) => obj('__Field', { name }));
        case 'enumValues':
          return typeInfo.enumValues === undefined ? null : typeInfo.enumValues.map((name) => obj('__EnumValue', { name }));
        case 'description':
          return null;
        default:
          return undefined;
      }
    }
    case '__Field': {
      const fieldInfo = value as { name: string };
      if (field.name === 'name') return fieldInfo.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      return undefined;
    }
    case '__EnumValue': {
      const enumInfo = value as { name: string };
      if (field.name === 'name') return enumInfo.name;
      if (field.name === 'description') return null;
      if (field.name === 'isDeprecated') return false;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The GraphQL type a selection runs against, for validation and fragment matching. */
function fieldType(parentType: string, fieldName: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
    Mutation: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User',
      defaultBranchRef: 'Ref',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequest: 'PullRequest',
      pullRequests: 'PullRequestConnection',
    },
    Issue: { repository: 'Repository', author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection' },
    PullRequest: { repository: 'Repository', author: 'User', files: 'PullRequestChangedFileConnection', mergeCommit: 'Commit' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', edges: 'IssueEdge' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', edges: 'PullRequestEdge' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
    IssueCommentConnection: { nodes: 'IssueComment', pageInfo: 'PageInfo' },
    LabelConnection: { nodes: 'Label', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue' },
    CommentEdge: { node: 'IssueComment' },
    IssueComment: { author: 'User' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
  };
  return map[parentType]?.[fieldName] ?? null;
}

function isKnownField(type: string, fieldName: string): boolean {
  if (fieldName === '__typename') return true;
  if (type === 'Query' && (fieldName === '__type' || fieldName === '__schema')) return true;
  if (type === 'Edge') return fieldName === 'node' || fieldName === 'cursor';
  const fields = TYPE_FIELDS[type];
  if (fields !== undefined) return fields.includes(fieldName);
  // Node and Edge are structural: their members resolve through the concrete types.
  if (type === 'Node') return fieldName === 'id';
  if (type === 'IssueEdge' || type === 'PullRequestEdge') return fieldName === 'node' || fieldName === 'cursor';
  return false;
}

function executeSelectionSet(
  source: GqlObject,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      if (condition === null || condition === source.$type || condition === 'Node') {
        Object.assign(out, executeSelectionSet(source, selection.selection, ctx));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = source.$type;
      continue;
    }
    if (!isKnownField(source.$type, selection.name)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${source.$type}'` });
      out[responseKey] = null;
      continue;
    }
    let resolved: unknown;
    try {
      resolved = resolveField(source, selection, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (resolved === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${source.$type}'` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(resolved, selection, source.$type, ctx);
  }
  return out;
}

function completeValue(resolved: unknown, field: FieldNode, parentType: string, ctx: ExecContext): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => completeValue(item, field, parentType, ctx));
  }
  if (typeof resolved === 'object' && '$type' in (resolved as Record<string, unknown>)) {
    const object = resolved as GqlObject;
    if (field.selection === null) return object.$value;
    return executeSelectionSet(object, field.selection, ctx);
  }
  return resolved;
}

/** Execute one GraphQL operation document; answers the {data, errors?} envelope. */
export function executeGraphQL(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors?: GqlError[] } {
  let operations: Operation[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    operations.find((candidate) => operationName !== undefined && candidate.name === operationName) ?? operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { forge: store, variables, errors: [] };
  const root = obj(operation.type === 'mutation' ? 'Mutation' : 'Query', null);
  const data = executeSelectionSet(root, operation.selection, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
