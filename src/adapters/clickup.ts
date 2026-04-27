import type { Bug, IssueAdapter } from './types.js'

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2'

export class ClickUpAdapter implements IssueAdapter {
  private token: string

  constructor(tokenEnv: string = 'CLICKUP_API_TOKEN') {
    const token = process.env[tokenEnv]
    if (!token) {
      throw new Error(
        `Missing ClickUp API token: environment variable "${tokenEnv}" is not set.`,
      )
    }
    this.token = token
  }

  private async clickupFetch(
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, any>,
  ): Promise<any> {
    const res = await fetch(`${CLICKUP_API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(
        `ClickUp API error ${res.status} ${method} ${endpoint}: ${text}`,
      )
    }

    return res.json()
  }

  /**
   * Parses a ClickUp task ID from multiple input formats:
   * - "CU-abc123"
   * - "abc123" (raw ID)
   * - "https://app.clickup.com/t/abc123"
   * - "https://app.clickup.com/t/86abc/slug"
   */
  static extractTaskId(input: string): string {
    const trimmed = input.trim()

    // CU-prefixed: "CU-abc123"
    const cuMatch = trimmed.match(/^CU-(.+)$/i)
    if (cuMatch) return cuMatch[1]

    // Full URL: https://app.clickup.com/t/abc123 or /t/86abc/slug
    const urlMatch = trimmed.match(
      /https?:\/\/app\.clickup\.com\/t\/([a-z0-9]+)/i,
    )
    if (urlMatch) return urlMatch[1]

    // Raw ID (fallback)
    return trimmed
  }

  async fetchIssue(rawId: string): Promise<Bug> {
    const taskId = ClickUpAdapter.extractTaskId(rawId)

    const [task, commentsRes] = await Promise.all([
      this.clickupFetch(`/task/${taskId}`),
      this.clickupFetch(`/task/${taskId}/comment`),
    ])

    const comments: string[] = (commentsRes.comments ?? []).map(
      (c: any) => c.comment_text ?? '',
    )

    return {
      id: task.id,
      title: task.name,
      description: task.description ?? '',
      comments,
      url: task.url ?? `https://app.clickup.com/t/${task.id}`,
      status: task.status?.status ?? 'unknown',
      metadata: {
        tags: task.tags ?? [],
        custom_fields: task.custom_fields ?? [],
      },
    }
  }

  async addComment(id: string, comment: string): Promise<void> {
    const taskId = ClickUpAdapter.extractTaskId(id)
    await this.clickupFetch(`/task/${taskId}/comment`, 'POST', {
      comment_text: comment,
    })
  }

  async updateStatus(id: string, status: string): Promise<void> {
    const taskId = ClickUpAdapter.extractTaskId(id)
    await this.clickupFetch(`/task/${taskId}`, 'PUT', { status })
  }
}
