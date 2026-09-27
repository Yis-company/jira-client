import { invoke, isTauri } from "@tauri-apps/api/core";

export type Session = { siteUrl: string; email: string; accountName: string };
export type Project = { id: string; key: string; name: string };
export type Board = { id: number; name: string; type: string };
export type Column = { name: string; statuses: string[] };
export type BoardConfig = { columns: Column[] };
export type FieldOption = { id: string | null; value: string | null; keys: string[] };
export type CreateField = { id: string; name: string; required: boolean; schemaType?: string; operations: string[]; allowedValueCount: number; allowedValues: FieldOption[]; unrecognizedValueCount: number; unrecognizedSamples: string[] };
export type IssueTypeMetadata = { id: string; name: string; description?: string; fields: CreateField[] };

export type DesktopBridge = {
  session(): Promise<Session | null>;
  connect(siteUrl: string, email: string, apiToken: string): Promise<Session>;
  disconnect(): Promise<void>;
  projects(): Promise<Project[]>;
  boards(projectKey: string): Promise<Board[]>;
  boardConfig(boardId: number): Promise<BoardConfig>;
  createMetadata(projectKey: string): Promise<IssueTypeMetadata[]>;
};

const desktop: DesktopBridge = {
  session: () => invoke("session"),
  connect: (siteUrl, email, apiToken) => invoke("connect", { siteUrl, email, apiToken }),
  disconnect: () => invoke("disconnect"),
  projects: () => invoke("projects"),
  boards: (projectKey) => invoke("boards", { projectKey }),
  boardConfig: (boardId) => invoke("board_config", { boardId }),
  createMetadata: (projectKey) => invoke("create_metadata", { projectKey }),
};

// The browser build is a product preview only. It cannot collect or persist credentials.
export const bridge: DesktopBridge = isTauri() ? desktop : {
  session: async () => null,
  connect: async () => { throw new Error("Open the desktop app to connect to Jira."); },
  disconnect: async () => undefined,
  projects: async () => { throw new Error("Open the desktop app to inspect Jira."); },
  boards: async () => { throw new Error("Open the desktop app to inspect Jira."); },
  boardConfig: async () => { throw new Error("Open the desktop app to inspect Jira."); },
  createMetadata: async () => { throw new Error("Open the desktop app to inspect Jira."); },
};
