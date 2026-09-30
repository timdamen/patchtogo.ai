import { stringify } from 'yaml'
import type { RepoRef } from './pipeline/ports.ts'

export const actions = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  setupNode: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  uploadArtifact: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  downloadArtifact: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
}

export const actionVersions = {
  checkout: 'v7.0.1',
  setupNode: 'v7.0.0',
  uploadArtifact: 'v7.0.1',
  downloadArtifact: 'v8.0.1'
}

export const setupNode = {
  name: `Set up Node.js (actions/setup-node ${actionVersions.setupNode})`,
  uses: actions.setupNode,
  with: { 'node-version': 24, 'package-manager-cache': false }
}

const safeName = /^[A-Za-z0-9._-]+$/
const safePath = /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value) || value.split('/').includes('..')) {
    throw new Error(`a patchtogo workflow cannot use the ${what} ${JSON.stringify(value)}`)
  }
  return value
}

export function safeRepository(fork: RepoRef): string {
  return [checked(fork.owner, safeName, 'owner'), checked(fork.repo, safeName, 'repository')].join(
    '/'
  )
}

export function safeDirectory(directory: string): string {
  return directory ? checked(directory, safePath, 'directory') : '.'
}

export function safeFile(path: string, what: string): string {
  return checked(path, safePath, what)
}

export function safeBefore(publishedAt: string | null): string {
  return publishedAt ? checked(publishedAt, isoDate, 'publish time') : ''
}

export function workflowYaml(workflow: object): string {
  return stringify(workflow, { version: '1.1', lineWidth: 0, aliasDuplicateObjects: false })
}
