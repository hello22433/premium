export interface ISsgIssue {
  issue(prefix: string, length: number): Promise<string>;
}
