import { insertSkill } from "../../../../shared/domain/file-mention";
import { SKILL_NAME_RE } from "../../../../shared/domain/skill";
import { chatKey } from "../../../../shared/domain/tab";
import { sessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useWindowStore } from "../../stores/window";

export async function useSkillInWorkspace(workspaceId: string, name: string): Promise<boolean> {
  if (!SKILL_NAME_RE.test(name)) return false;
  if (!(await useWindowStore.getState().openWorkspace(workspaceId))) return false;
  const window = useWindowStore.getState();
  if (window.activeWorkspaceId !== workspaceId || window.pendingActivation !== null || window.activeStandaloneFeature !== null) return false;
  const tabs = useTabsStore.getState();
  let state = tabs.stateOf(workspaceId);
  let active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (active?.kind !== "chat") {
    tabs.newChat(workspaceId);
    state = tabs.stateOf(workspaceId);
    active = state.tabs.find((tab) => tab.id === state.activeTabId);
  }
  if (active?.kind !== "chat") return false;
  const session = sessionStore(chatKey(active)).getState();
  const draft =
    session.draft === "" || /\s$/.test(session.draft)
      ? session.draft
      : `${session.draft} `;
  session.setDraft(
    insertSkill(draft, { start: draft.length, end: draft.length }, name).text,
  );
  return true;
}
