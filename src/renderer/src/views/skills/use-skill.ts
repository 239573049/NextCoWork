import { insertSkill } from "../../../../shared/domain/file-mention";
import { SKILL_NAME_RE } from "../../../../shared/domain/skill";
import { chatKey } from "../../../../shared/domain/tab";
import { sessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useWindowStore } from "../../stores/window";

/** Persist the draft before revealing the chat, which is unmounted in Skills mode. */
export function useSkillInWorkspace(workspaceId: string, name: string): void {
  if (!SKILL_NAME_RE.test(name)) return;
  const tabs = useTabsStore.getState();
  let state = tabs.stateOf(workspaceId);
  let active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (active?.kind !== "chat") {
    tabs.newChat(workspaceId);
    state = tabs.stateOf(workspaceId);
    active = state.tabs.find((tab) => tab.id === state.activeTabId);
  }
  if (active?.kind !== "chat") return;
  const session = sessionStore(chatKey(active)).getState();
  const draft =
    session.draft === "" || /\s$/.test(session.draft)
      ? session.draft
      : `${session.draft} `;
  session.setDraft(
    insertSkill(draft, { start: draft.length, end: draft.length }, name).text,
  );
  useWindowStore.getState().openWorkspace(workspaceId);
}
