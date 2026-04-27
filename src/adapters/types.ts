export interface Bug {
  id: string
  title: string
  description: string
  comments: string[]
  url: string
  status: string
  metadata: Record<string, any>
}

export interface IssueAdapter {
  fetchIssue(id: string): Promise<Bug>
  addComment(id: string, comment: string): Promise<void>
  updateStatus(id: string, status: string): Promise<void>
}
