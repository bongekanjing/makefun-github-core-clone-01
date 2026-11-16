// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send (see kit checks-graphql.ts GRAPHQL_DOCUMENTS): a lexer,
// a recursive-descent parser for operations, fields, aliases, arguments, variables
// and inline fragments, a validator against a small schema table, and resolvers over
// the forge's store. Unknown fields are GraphQL errors (HTTP 200 with `errors`),
// never HTTP errors; unknown repositories read `data.repository = null`.

import {
  Store,
  VIEWER,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  commentGlobalId,
  tsFor,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { parseCommit } from './git.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and plain strings.
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch) || ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === '(' || ch === ')' || ch === ':' || ch === '=' || ch === '@' || ch === '!' || ch === '$' || ch === '|') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; type: string }>;
  selection: SelectionNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }
  peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }
  next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }
  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    return token.value;
  }
  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }
  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const varDefs: Array<{ name: string; type: string }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const varType = this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        varDefs.push({ name: varName, type: varType });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { type, name, varDefs, selection };
  }
  parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }
  parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (this.peek().kind === 'name') {
        // A named fragment spread: unsupported by the documents we serve; treat as an error.
        throw new Error(`named fragment ${this.peek().value} is not supported`);
      }
      return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selection } };
  }
  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- schema table (fields each type exposes)

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'comments',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'headRef', 'baseRef', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'comments',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'url', 'createdAt', 'updatedAt',
  ],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE', 'TOPIC', 'LABEL', 'MILESTONE'];

// ---------------------------------------------------------------- execution

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

type Variables = Record<string, unknown>;

function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

interface TypedObject {
  __typename: string;
  [key: string]: unknown;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

export class GraphQLExecutor {
  #store: Store;
  constructor(store: Store) {
    this.#store = store;
  }

  execute(document: string, variables: Variables): { data: Record<string, unknown> | null; errors: GqlError[] } {
    let operations: Operation[];
    try {
      operations = new Parser(lex(document)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    if (operations.length === 0) return { data: null, errors: [{ message: 'no operation in GraphQL document' }] };
    // The suite sends one operation per body (or a batch of bodies, handled by the caller).
    const operation = operations[0] as Operation;
    const errors: GqlError[] = [];
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data: Record<string, unknown> = {};
    for (const selection of operation.selection) {
      if (selection.kind === 'inlineFragment') continue;
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (!SCHEMA[rootType]?.includes(field.name)) {
        errors.push({ message: `Cannot query field "${field.name}" on type "${rootType}".`, path: [key] });
        data[key] = null;
        continue;
      }
      try {
        data[key] = this.resolveRoot(field, operation.type, variables, errors, [key]);
      } catch (err) {
        errors.push({ message: err instanceof Error ? err.message : String(err), path: [key] });
        data[key] = null;
      }
    }
    return { data, errors };
  }

  // -- generic field resolution ---------------------------------------------

  #resolveFields(object: TypedObject, selection: SelectionNode[] | null, variables: Variables, errors: GqlError[], path: Array<string | number>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (selection === null) return out;
    for (const node of selection) {
      if (node.kind === 'inlineFragment') {
        if (node.typeCondition !== null && node.typeCondition !== object.__typename) continue;
        Object.assign(out, this.#resolveFields(object, node.selection, variables, errors, path));
        continue;
      }
      const field = node.field;
      const key = field.alias ?? field.name;
      const typeName = object.__typename;
      if (!SCHEMA[typeName]?.includes(field.name)) {
        errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = this.#resolveField(object, field, variables, errors, [...path, key]);
    }
    return out;
  }

  #resolveField(object: TypedObject, field: FieldNode, variables: Variables, errors: GqlError[], path: Array<string | number>): unknown {
    const args = argsOf(field, variables);
    const value = this.#fieldValue(object, field.name, args);
    if (value === null || value === undefined) return null;
    if (field.selection === null) return value;
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
          ? this.#resolveFields(entry as TypedObject, field.selection, variables, errors, [...path, index])
          : entry,
      );
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      return this.#resolveFields(value as TypedObject, field.selection, variables, errors, path);
    }
    return value;
  }

  #fieldValue(object: TypedObject, name: string, args: Record<string, unknown>): unknown {
    const typeName = object.__typename;
    if (typeName === 'User') {
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return String(VIEWER.id);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
    }
    if (typeName === 'Repository') return this.#repositoryField(object, name, args);
    if (typeName === 'Issue') return this.#issueField(object, name);
    if (typeName === 'PullRequest') return this.#pullField(object, name, args);
    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
      if (name === 'nodes') return (object.nodes as unknown[]) ?? [];
      if (name === 'edges') return (object.edges as unknown[]) ?? [];
      if (name === 'pageInfo') return object.pageInfo ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      if (name === 'totalCount') return (object.nodes as unknown[])?.length ?? 0;
    }
    if (typeName === 'PageInfo') return object[name] ?? null;
    if (typeName === 'Ref') return object[name] ?? null;
    if (typeName === '__Type') {
      if (name === 'name') return object.name ?? null;
      if (name === 'kind') return object.kind ?? 'OBJECT';
      if (name === 'fields') return (object.fieldNames as string[] ?? []).map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null, args: [], type: null }));
      if (name === 'enumValues') return (object.enumNames as string[] ?? []).map((enumName) => ({ __typename: '__EnumValue', name: enumName, description: null }));
      if (name === 'description') return null;
    }
    if (typeName === '__Field') return object[name] ?? null;
    if (typeName === '__EnumValue') return object[name] ?? null;
    if (typeName === '__Schema') {
      if (name === 'queryType') return { __typename: '__Type', name: 'Query', kind: 'OBJECT', fieldNames: SCHEMA.Query, enumNames: [] };
      if (name === 'mutationType') return { __typename: '__Type', name: 'Mutation', kind: 'OBJECT', fieldNames: SCHEMA.Mutation, enumNames: [] };
      if (name === 'types') {
        return Object.keys(SCHEMA).map((type) => ({ __typename: '__Type', name: type, kind: 'OBJECT', fieldNames: SCHEMA[type] ?? [], enumNames: [] }));
      }
    }
    if (typeName === 'IssueComment') return object[name] ?? null;
    if (typeName === 'PullRequestChangedFile') return object[name] ?? null;
    if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') return object[name] ?? null;
    if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') return object[name] ?? null;
    if (typeName === 'AddCommentPayload') return object[name] ?? null;
    if (typeName === 'IssueCommentEdge') return object[name] ?? null;
    if (typeName === 'IssueEdge') return object[name] ?? null;
    return object[name] ?? null;
  }

  // -- roots -----------------------------------------------------------------

  resolveRoot(field: FieldNode, operationType: 'query' | 'mutation', variables: Variables, errors: GqlError[], path: Array<string | number>): unknown {
    const args = argsOf(field, variables);
    if (operationType === 'mutation') return this.#resolveMutation(field, args, variables, errors, path);
    if (field.name === 'viewer') {
      const user: TypedObject = { __typename: 'User' };
      return field.selection === null ? user : this.#resolveFields(user, field.selection, variables, errors, path);
    }
    if (field.name === 'repository') {
      const repo = this.#findRepo(args.owner, args.name);
      if (repo === null) return null;
      const object = this.#repositoryObject(repo);
      return field.selection === null ? object : this.#resolveFields(object, field.selection, variables, errors, path);
    }
    if (field.name === 'node') {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (decoded === null) return null;
      const repo = this.#store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) return null;
      let object: TypedObject | null = null;
      if (decoded.kind === 'repo') object = this.#repositoryObject(repo);
      else if (decoded.kind === 'issue') {
        const issue = repo.issues.find((entry) => entry.number === decoded.number);
        if (issue !== undefined) object = this.#issueObject(repo, issue);
      } else if (decoded.kind === 'pr') {
        const pull = repo.pulls.find((entry) => entry.number === decoded.number);
        if (pull !== undefined) object = this.#pullObject(repo, pull);
      }
      if (object === null) return null;
      return field.selection === null ? object : this.#resolveFields(object, field.selection, variables, errors, path);
    }
    if (field.name === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (name === 'SearchType') {
        const object: TypedObject = { __typename: '__Type', name, kind: 'ENUM', fieldNames: [], enumNames: SEARCH_TYPE_VALUES };
        return field.selection === null ? object : this.#resolveFields(object, field.selection, variables, errors, path);
      }
      const fieldNames = INTROSPECTION_FIELDS[name] ?? SCHEMA[name];
      if (fieldNames === undefined) return null;
      const object: TypedObject = { __typename: '__Type', name, kind: 'OBJECT', fieldNames, enumNames: [] };
      return field.selection === null ? object : this.#resolveFields(object, field.selection, variables, errors, path);
    }
    if (field.name === '__schema') {
      const object: TypedObject = { __typename: '__Schema' };
      return field.selection === null ? object : this.#resolveFields(object, field.selection, variables, errors, path);
    }
    return null;
  }

  #resolveMutation(field: FieldNode, args: Record<string, unknown>, variables: Variables, errors: GqlError[], path: Array<string | number>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'repo') throw new Error('createIssue: unknown repositoryId');
      const repo = this.#store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new Error('createIssue: unknown repository');
      const created = this.#store.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
      if ('error' in created) throw new Error(`createIssue: ${created.error}`);
      const payload: TypedObject = { __typename: 'CreateIssuePayload', issue: this.#issueObject(repo, created), clientMutationId: null };
      return field.selection === null ? payload : this.#resolveFields(payload, field.selection, variables, errors, path);
    }
    if (field.name === 'closeIssue') {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (decoded === null || decoded.kind !== 'issue') throw new Error('closeIssue: unknown issueId');
      const repo = this.#store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((entry) => entry.number === decoded.number);
      if (repo === undefined || issue === undefined) throw new Error('closeIssue: unknown issue');
      issue.state = 'closed';
      issue.closedSeq = this.#store.seq();
      this.#store.queueSave();
      const payload: TypedObject = { __typename: 'CloseIssuePayload', issue: this.#issueObject(repo, issue), clientMutationId: null };
      return field.selection === null ? payload : this.#resolveFields(payload, field.selection, variables, errors, path);
    }
    if (field.name === 'createPullRequest') {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      if (decoded === null || decoded.kind !== 'repo') throw new Error('createPullRequest: unknown repositoryId');
      const repo = this.#store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new Error('createPullRequest: unknown repository');
      const created = this.#store.createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in created) throw new Error(`createPullRequest: ${created.error}`);
      const payload: TypedObject = { __typename: 'CreatePullRequestPayload', pullRequest: this.#pullObject(repo, created), clientMutationId: null };
      return field.selection === null ? payload : this.#resolveFields(payload, field.selection, variables, errors, path);
    }
    if (field.name === 'mergePullRequest') {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (decoded === null || decoded.kind !== 'pr') throw new Error('mergePullRequest: unknown pullRequestId');
      const repo = this.#store.getRepo(decoded.owner, decoded.name);
      const pull = repo?.pulls.find((entry) => entry.number === decoded.number);
      if (repo === undefined || pull === undefined) throw new Error('mergePullRequest: unknown pull request');
      const merged = this.#store.mergePull(repo, pull);
      if ('error' in merged) throw new Error(`mergePullRequest: ${merged.error}`);
      const payload: TypedObject = { __typename: 'MergePullRequestPayload', pullRequest: this.#pullObject(repo, pull), clientMutationId: null };
      return field.selection === null ? payload : this.#resolveFields(payload, field.selection, variables, errors, path);
    }
    if (field.name === 'addComment') {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (decoded === null || decoded.kind !== 'issue') throw new Error('addComment: unknown subjectId');
      const repo = this.#store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((entry) => entry.number === decoded.number);
      if (repo === undefined || issue === undefined) throw new Error('addComment: unknown issue');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: this.#store.nextCommentId++, body, seq: this.#store.seq() };
      issue.comments.push(comment);
      this.#store.queueSave();
      const node: TypedObject = { __typename: 'IssueComment', id: commentGlobalId(repo, comment.id), body, author: { __typename: 'User' }, createdAt: tsFor(comment.seq) };
      const edge: TypedObject = { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) };
      const payload: TypedObject = { __typename: 'AddCommentPayload', commentEdge: edge, clientMutationId: null };
      return field.selection === null ? payload : this.#resolveFields(payload, field.selection, variables, errors, path);
    }
    return null;
  }

  // -- object shapes ----------------------------------------------------------

  #findRepo(owner: unknown, name: unknown): Repo | null {
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== VIEWER.login) return null;
    return this.#store.getRepo(owner, name) ?? null;
  }

  #repositoryObject(repo: Repo): TypedObject {
    return {
      __typename: 'Repository',
      _repo: repo,
      id: repoGlobalId(repo),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      description: repo.description,
      private: repo.private,
      createdAt: tsFor(repo.createdSeq),
      updatedAt: tsFor(repo.createdSeq),
    };
  }

  #issueObject(repo: Repo, issue: Issue): TypedObject {
    return {
      __typename: 'Issue',
      _repo: repo,
      _issue: issue,
      id: issueGlobalId(repo, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      createdAt: tsFor(issue.seq),
      updatedAt: tsFor(issue.closedSeq ?? issue.seq),
      author: { __typename: 'User' },
      url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  #pullObject(repo: Repo, pull: Pull): TypedObject {
    return {
      __typename: 'PullRequest',
      _repo: repo,
      _pull: pull,
      id: pullGlobalId(repo, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      createdAt: tsFor(pull.seq),
      updatedAt: tsFor(pull.seq),
      mergedAt: pull.mergedAt,
      author: { __typename: 'User' },
    };
  }

  #repositoryField(object: TypedObject, name: string, args: Record<string, unknown>): unknown {
    const repo = object._repo as Repo;
    if (name === 'owner') return { __typename: 'User' };
    if (name === 'defaultBranchRef') {
      const tip = this.#store.defaultTip(repo);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : this.#issueObject(repo, issue);
    }
    if (name === 'issues') return this.#issuesConnection(repo, args);
    if (name === 'pullRequests') return this.#pullsConnection(repo, args);
    if (name === 'pullRequest') {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : this.#pullObject(repo, pull);
    }
    if (name === 'url') return `/${repo.owner}/${repo.name}`;
    return object[name] ?? null;
  }

  #issueField(object: TypedObject, name: string): unknown {
    const issue = object._issue as Issue;
    if (name === 'comments') {
      const repo = object._repo as Repo;
      return {
        __typename: 'IssueConnection',
        nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: commentGlobalId(repo, comment.id), body: comment.body, author: { __typename: 'User' }, createdAt: tsFor(comment.seq) })),
        edges: [],
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
    if (name === 'labels') return issue.labels.map((label) => ({ name: label.name, color: label.color }));
    return object[name] ?? null;
  }

  #pullField(object: TypedObject, name: string, args: Record<string, unknown>): unknown {
    const repo = object._repo as Repo;
    const pull = object._pull as Pull;
    if (name === 'mergeable') return this.#store.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    if (name === 'files') {
      const files = this.#store.pullFiles(repo, pull);
      const first = typeof args.first === 'number' ? args.first : files.length;
      const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, filename: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes, status: file.status }));
      return { __typename: 'PullRequestChangedFileConnection', nodes, edges: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name === 'headRef') return { __typename: 'Ref', name: pull.headRef };
    if (name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
    if (name === 'mergeCommit') {
      if (pull.mergeCommitSha === null) return null;
      const commitObject = repo.objects.get(pull.mergeCommitSha);
      if (commitObject === undefined) return null;
      return { __typename: 'Commit', oid: pull.mergeCommitSha, message: parseCommit(commitObject.data).message };
    }
    return object[name] ?? null;
  }

  #issuesConnection(repo: Repo, args: Record<string, unknown>): TypedObject {
    let issues = [...repo.issues];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy as Record<string, unknown> | undefined;
    if (orderBy !== undefined && typeof orderBy === 'object') {
      const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
      issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
    } else {
      issues.sort((a, b) => a.seq - b.seq || a.number - b.number);
    }
    const afterNumber = numberFromCursor(args.after);
    if (afterNumber !== null) {
      const index = issues.findIndex((issue) => issue.number === afterNumber);
      if (index >= 0) issues = issues.slice(index + 1);
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
    return {
      __typename: 'IssueConnection',
      nodes: page.map((issue) => this.#issueObject(repo, issue)),
      edges: page.map((issue) => ({ __typename: 'IssueEdge', node: this.#issueObject(repo, issue), cursor: cursorFor(issue.number) })),
      pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor((page[0] as Issue).number) : null, endCursor },
    };
  }

  #pullsConnection(repo: Repo, args: Record<string, unknown>): TypedObject {
    let pulls = repo.pulls.filter((pull) => pull.state === 'open');
    pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
    const first = typeof args.first === 'number' ? args.first : pulls.length;
    const page = pulls.slice(0, first);
    return {
      __typename: 'PullRequestConnection',
      nodes: page.map((pull) => this.#pullObject(repo, pull)),
      edges: [],
      pageInfo: { __typename: 'PageInfo', hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
    };
  }
}
