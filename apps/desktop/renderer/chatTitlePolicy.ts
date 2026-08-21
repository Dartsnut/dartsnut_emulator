export type InitialChatTitleState = {
  id: string;
  title: string;
};

export function shouldSetInitialChatTitle(
  firstUserMessage: string | undefined,
  requestChatId: string | undefined,
  activeChat: InitialChatTitleState | null
): boolean {
  if (!firstUserMessage?.trim()) return false;
  if (!requestChatId) return true;
  return activeChat?.id === requestChatId && activeChat.title === "New chat";
}
