import type { IssueAdapter } from './types.js'
import { ClickUpAdapter } from './clickup.js'
import { HeadlessAdapter } from './headless.js'

export { type Bug, type IssueAdapter } from './types.js'
export { ClickUpAdapter } from './clickup.js'
export { HeadlessAdapter } from './headless.js'

export function createAdapter(type: string, config?: { tokenEnv?: string }): IssueAdapter {
  switch (type) {
    case 'clickup':
      return new ClickUpAdapter(config?.tokenEnv)
    case 'headless':
      return new HeadlessAdapter()
    default:
      throw new Error(`Unknown issue tracker type: "${type}". Supported: clickup, headless`)
  }
}
