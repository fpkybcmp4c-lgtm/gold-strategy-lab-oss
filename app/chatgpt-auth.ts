/** Single local profile; no remote identity provider or user registry. */
export type LocalUser = { userId: string; displayName: string };
export async function getChatGPTUser(): Promise<LocalUser> { return { userId: 'local-owner', displayName: '个人工作台' }; }
export async function requireChatGPTUser(_returnTo: string): Promise<LocalUser> { return getChatGPTUser(); }
