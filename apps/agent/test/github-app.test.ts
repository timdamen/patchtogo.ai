import { Octokit } from '@octokit/rest'
import { describe, expect, it } from 'vitest'
import { createGitHubApp } from '../src/github-app.ts'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

type Route = (call: Call) => { status: number; body?: unknown } | undefined

const sha = (char: string) => char.repeat(40)

function fakeGitHub(...routes: Route[]) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const call = {
      method: init?.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    for (const route of routes) {
      const response = route(call)
      if (!response) continue
      const text =
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {})
      return new Response(response.status === 204 ? null : text, {
        status: response.status,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  }
  const github = createGitHubApp(new Octokit({ request: { fetch, retries: 0 } }), {
    pollIntervalMs: 1,
    forkReadyTimeoutMs: 1000
  })
  return { github, calls }
}

function on(method: string, path: string, status: number, body?: unknown): Route {
  return (call) => (call.method === method && call.path === path ? { status, body } : undefined)
}

const upstream = { owner: 'component', repo: 'escape-html' }
const into = { owner: 'patchtogo-ai', repo: 'escape-html' }
const forkData = {
  name: 'escape-html',
  owner: { login: 'patchtogo-ai' },
  fork: true,
  default_branch: 'master',
  parent: { full_name: 'component/escape-html' },
  source: { full_name: 'component/escape-html' }
}

describe('GitHub App adapter', () => {
  it('reuses an existing fork of the upstream repository', async () => {
    const { github, calls } = fakeGitHub(
      on('GET', '/repos/patchtogo-ai/escape-html', 200, forkData),
      on('GET', '/repos/patchtogo-ai/escape-html/commits/master', 200, sha('a'))
    )

    expect(await github.forkRepository(upstream, into)).toEqual(into)
    expect(calls.map((c) => c.method)).not.toContain('POST')
  })

  it('forks into the organisation and waits until the fork has its commits', async () => {
    let polls = 0
    const { github, calls } = fakeGitHub(
      on('POST', '/repos/component/escape-html/forks', 202, forkData),
      (call) =>
        call.path === '/repos/patchtogo-ai/escape-html/commits/master'
          ? ++polls < 3
            ? { status: 409, body: { message: 'Git Repository is empty.' } }
            : { status: 200, body: sha('a') }
          : undefined
    )

    expect(await github.forkRepository(upstream, into)).toEqual(into)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      organization: 'patchtogo-ai',
      name: 'escape-html',
      default_branch_only: false
    })
    expect(polls).toBe(3)
  })

  it.each([
    ['not a fork', { fork: false }],
    [
      'a fork of another repository',
      {
        parent: { full_name: 'someone/escape-html' },
        source: { full_name: 'someone/escape-html' }
      }
    ]
  ])('refuses a repository with the fork name that is %s', async (_case, repository) => {
    const { github } = fakeGitHub(
      on('GET', '/repos/patchtogo-ai/escape-html', 200, { ...forkData, ...repository })
    )

    await expect(github.forkRepository(upstream, into)).rejects.toThrow(
      'patchtogo-ai/escape-html exists and is not a fork of component/escape-html'
    )
  })

  it('resolves release refs to commits and treats unknown refs as missing', async () => {
    const { github } = fakeGitHub(
      on('GET', '/repos/component/escape-html/commits/v1.0.3', 200, sha('b')),
      on('GET', '/repos/component/escape-html/commits/1.0.3', 422, { message: 'No commit found' })
    )

    expect(await github.findCommit(upstream, 'v1.0.3')).toBe(sha('b'))
    expect(await github.findCommit(upstream, '1.0.3')).toBeUndefined()
    expect(await github.findCommit(upstream, 'escape-html@1.0.3')).toBeUndefined()
  })

  it('commits every change in one commit and creates the branch with a single ref', async () => {
    const { github, calls } = fakeGitHub(
      on('GET', `/repos/patchtogo-ai/escape-html/git/commits/${sha('a')}`, 200, {
        sha: sha('a'),
        tree: { sha: sha('t') }
      }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/trees', 201, { sha: sha('u') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/commits', 201, { sha: sha('c') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/refs', 201, {})
    )

    const head = await github.createBranch(into, {
      name: 'ptg/base/escape-html/1.0.3',
      parent: sha('a'),
      message: 'chore: patchtogo scaffolding',
      changes: [
        { path: 'package.json', content: '{}\n' },
        { path: '.github/workflows/ci.yml', delete: true }
      ]
    })

    expect(head).toBe(sha('c'))
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      [
        '/repos/patchtogo-ai/escape-html/git/trees',
        {
          base_tree: sha('t'),
          tree: [
            { path: 'package.json', mode: '100644', type: 'blob', content: '{}\n' },
            { path: '.github/workflows/ci.yml', mode: '100644', type: 'blob', sha: null }
          ]
        }
      ],
      [
        '/repos/patchtogo-ai/escape-html/git/commits',
        { message: 'chore: patchtogo scaffolding', tree: sha('u'), parents: [sha('a')] }
      ],
      [
        '/repos/patchtogo-ai/escape-html/git/refs',
        { ref: 'refs/heads/ptg/base/escape-html/1.0.3', sha: sha('c') }
      ]
    ])
  })

  it('returns the existing branch head when another attempt created the branch first', async () => {
    const { github } = fakeGitHub(
      on('GET', `/repos/patchtogo-ai/escape-html/git/commits/${sha('a')}`, 200, {
        tree: { sha: sha('t') }
      }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/trees', 201, { sha: sha('u') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/commits', 201, { sha: sha('c') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/refs', 422, {
        message: 'Reference already exists'
      }),
      on('GET', '/repos/patchtogo-ai/escape-html/git/ref/heads/ptg/base/escape-html/1.0.3', 200, {
        object: { sha: sha('d') }
      })
    )

    const head = await github.createBranch(into, {
      name: 'ptg/base/escape-html/1.0.3',
      parent: sha('a'),
      message: 'm',
      changes: []
    })

    expect(head).toBe(sha('d'))
  })

  it('adds one commit to an existing branch and moves it without forcing', async () => {
    const { github, calls } = fakeGitHub(
      on('GET', `/repos/patchtogo-ai/escape-html/git/commits/${sha('a')}`, 200, {
        tree: { sha: sha('t') }
      }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/trees', 201, { sha: sha('u') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/commits', 201, { sha: sha('c') }),
      on(
        'PATCH',
        '/repos/patchtogo-ai/escape-html/git/refs/heads/ptg/base/escape-html/1.0.3',
        200,
        {
          object: { sha: sha('c') }
        }
      )
    )

    const head = await github.updateBranch(into, {
      name: 'ptg/base/escape-html/1.0.3',
      parent: sha('a'),
      message: 'chore: update the patchtogo scaffolding',
      changes: [{ path: '.github/workflows/patchtogo-preview.yml', content: 'on: push\n' }]
    })

    expect(head).toBe(sha('c'))
    expect(calls.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST')?.body).toEqual(
      { message: 'chore: update the patchtogo scaffolding', tree: sha('u'), parents: [sha('a')] }
    )
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sha: sha('c'), force: false })
    expect(calls.some((c) => c.path.endsWith('/git/refs') && c.method === 'POST')).toBe(false)
  })

  it('keeps the file mode a change asks for', async () => {
    const { github, calls } = fakeGitHub(
      on('GET', `/repos/patchtogo-ai/escape-html/git/commits/${sha('a')}`, 200, {
        tree: { sha: sha('t') }
      }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/trees', 201, { sha: sha('u') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/commits', 201, { sha: sha('c') }),
      on('POST', '/repos/patchtogo-ai/escape-html/git/refs', 201, {})
    )

    await github.createBranch(into, {
      name: 'ptg/patch/escape-html/1.0.3/ghsa-x',
      parent: sha('a'),
      message: 'fix',
      changes: [{ path: 'test/run.sh', content: 'echo ok\n', mode: '100755' }]
    })

    expect(calls.find((c) => c.path.endsWith('/git/trees'))?.body).toMatchObject({
      tree: [{ path: 'test/run.sh', mode: '100755' }]
    })
  })

  it('opens a pull request inside the fork and requests the reviewer team', async () => {
    const pr = { number: 7, html_url: 'https://github.com/patchtogo-ai/escape-html/pull/7' }
    const { github, calls } = fakeGitHub(
      on('POST', '/repos/patchtogo-ai/escape-html/pulls', 201, pr),
      on('POST', '/repos/patchtogo-ai/escape-html/pulls/7/requested_reviewers', 201, {})
    )

    const opened = await github.openPullRequest(into, {
      head: 'ptg/patch/escape-html/1.0.3/ghsa-x',
      base: 'ptg/base/escape-html/1.0.3',
      title: 't',
      body: 'b'
    })
    await github.requestTeamReview(into, opened.number, 'reviewers')

    expect(opened).toEqual({ number: 7, url: pr.html_url })
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      [
        'POST',
        '/repos/patchtogo-ai/escape-html/pulls',
        {
          head: 'ptg/patch/escape-html/1.0.3/ghsa-x',
          base: 'ptg/base/escape-html/1.0.3',
          title: 't',
          body: 'b'
        }
      ],
      [
        'POST',
        '/repos/patchtogo-ai/escape-html/pulls/7/requested_reviewers',
        { team_reviewers: ['reviewers'] }
      ]
    ])
  })

  it('finds the open pull request of a branch, also when opening one races another attempt', async () => {
    const pr = { number: 7, html_url: 'https://github.com/patchtogo-ai/escape-html/pull/7' }
    const { github, calls } = fakeGitHub(
      on('POST', '/repos/patchtogo-ai/escape-html/pulls', 422, {
        message: 'A pull request already exists for patchtogo-ai:ptg/patch/x.'
      }),
      on('GET', '/repos/patchtogo-ai/escape-html/pulls', 200, [pr])
    )

    const found = await github.findPullRequest(into, 'ptg/patch/x')
    const opened = await github.openPullRequest(into, {
      head: 'ptg/patch/x',
      base: 'ptg/base/x',
      title: 't',
      body: 'b'
    })

    expect(found).toEqual({ number: 7, url: pr.html_url })
    expect(opened).toEqual(found)
    const lookup = calls.find((c) => c.method === 'GET')
    expect(lookup?.path).toBe('/repos/patchtogo-ai/escape-html/pulls')
    expect(lookup?.query.get('head')).toBe('patchtogo-ai:ptg/patch/x')
    expect(lookup?.query.get('state')).toBe('open')
  })

  describe('the review loop', () => {
    const repo = '/repos/patchtogo-ai/escape-html'
    const branch = 'ptg/patch/escape-html/1.0.3/ghsa-x'
    const refPath = `${repo}/git/ref/heads/${branch}`

    it.each([
      ['an active member', 200, { state: 'active' }, true],
      ['an invited member who has not accepted', 200, { state: 'pending' }, false],
      ['someone outside the team', 404, { message: 'Not Found' }, false]
    ])('counts %s as a reviewer: %s', async (_case, status, body, reviewer) => {
      const { github } = fakeGitHub(
        on('GET', '/orgs/patchtogo-ai/teams/reviewers/memberships/alice', status, body)
      )

      expect(await github.isTeamMember('patchtogo-ai', 'reviewers', 'alice')).toBe(reviewer)
    })

    it('reads a review with its inline comments and marks non-users as bots', async () => {
      const { github } = fakeGitHub(
        on('GET', `${repo}/pulls/1/reviews/21`, 200, {
          id: 21,
          user: { login: 'alice', type: 'User' },
          state: 'CHANGES_REQUESTED',
          body: 'Two things.',
          html_url: 'https://github.com/r#pullrequestreview-21'
        }),
        on('GET', `${repo}/pulls/1/reviews/21/comments`, 200, [
          { id: 31, path: 'index.js', line: 3, body: 'Here.', html_url: 'u31' },
          {
            id: 32,
            path: 'old.js',
            line: null,
            original_line: 7,
            body: 'Outdated.',
            html_url: 'u32'
          }
        ]),
        on('GET', `${repo}/pulls/1/reviews/22`, 200, {
          id: 22,
          user: { login: 'renovate[bot]', type: 'Bot' },
          state: 'APPROVED',
          body: null,
          html_url: 'u22'
        }),
        on('GET', `${repo}/pulls/1/reviews/22/comments`, 200, [])
      )

      expect(await github.getReview(into, 1, 21)).toEqual({
        id: 21,
        author: { login: 'alice', bot: false },
        state: 'changes_requested',
        body: 'Two things.',
        url: 'https://github.com/r#pullrequestreview-21',
        comments: [
          { id: 31, path: 'index.js', line: 3, body: 'Here.', url: 'u31' },
          { id: 32, path: 'old.js', line: 7, body: 'Outdated.', url: 'u32' }
        ]
      })
      expect(await github.getReview(into, 1, 22)).toMatchObject({
        author: { login: 'renovate[bot]', bot: true },
        state: 'approved',
        body: ''
      })
      expect(await github.getReview(into, 1, 23)).toBeUndefined()
    })

    it('commits the changes on the tree of one commit with another commit as parent', async () => {
      const { github, calls } = fakeGitHub(
        on('GET', `${repo}/git/commits/${sha('b')}`, 200, { tree: { sha: sha('t') } }),
        on('POST', `${repo}/git/trees`, 201, { sha: sha('u') }),
        on('POST', `${repo}/git/commits`, 201, { sha: sha('c') })
      )

      const commit = await github.createCommit(into, {
        parent: sha('p'),
        treeFrom: sha('b'),
        message: 'fix: iteration',
        changes: [{ path: 'index.js', content: 'fixed\n' }]
      })

      expect(commit).toBe(sha('c'))
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        {
          base_tree: sha('t'),
          tree: [{ path: 'index.js', mode: '100644', type: 'blob', content: 'fixed\n' }]
        },
        { message: 'fix: iteration', tree: sha('u'), parents: [sha('p')] }
      ])
      expect(calls.some((c) => c.path.includes('/git/refs'))).toBe(false)
    })

    it('moves a branch only forward from the commit it expects', async () => {
      let head = sha('a')
      const { github, calls } = fakeGitHub(
        (call) =>
          call.method === 'GET' && call.path === refPath
            ? { status: 200, body: { object: { sha: head } } }
            : undefined,
        (call) => {
          if (call.method !== 'PATCH' || call.path !== `${repo}/git/refs/heads/${branch}`) {
            return undefined
          }
          head = (call.body as { sha: string }).sha
          return { status: 200, body: { object: { sha: head } } }
        }
      )

      expect(await github.moveBranch(into, branch, { from: sha('a'), to: sha('c') })).toBe(true)
      expect(await github.moveBranch(into, branch, { from: sha('a'), to: sha('c') })).toBe(true)
      expect(await github.moveBranch(into, branch, { from: sha('a'), to: sha('d') })).toBe(false)

      expect(head).toBe(sha('c'))
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { sha: sha('c'), force: false }
      ])
    })

    it('reports a branch that someone moved during the update as not moved', async () => {
      const { github } = fakeGitHub(
        on('GET', refPath, 200, { object: { sha: sha('a') } }),
        on('PATCH', `${repo}/git/refs/heads/${branch}`, 422, {
          message: 'Update is not a fast forward'
        })
      )

      expect(await github.moveBranch(into, branch, { from: sha('a'), to: sha('c') })).toBe(false)
    })

    it.each([
      ['posts a reply that no bot comment carries the marker of yet', 'User', 1],
      ['skips a reply its bot already posted', 'Bot', 0]
    ])('%s', async (_case, type, posts) => {
      const { github, calls } = fakeGitHub(
        on('GET', `${repo}/issues/1/comments`, 200, [
          { id: 1, user: { login: 'someone', type }, body: '<!-- patchtogo:iteration:1 -->\nold' }
        ]),
        on('POST', `${repo}/issues/1/comments`, 201, { id: 2 })
      )

      await github.commentOnPullRequest(into, 1, {
        marker: 'patchtogo:iteration:1',
        body: '<!-- patchtogo:iteration:1 -->\nnew'
      })

      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual(
        posts ? [{ body: '<!-- patchtogo:iteration:1 -->\nnew' }] : []
      )
    })
  })
})
