import type {
  SkillInstallScope,
  SkillListItem,
  SkillMarketItem,
} from "../../../shared/domain/skill";
import { invoke, on } from "./ipc";

export function listSkills(workspaceId?: string): Promise<SkillListItem[]> {
  return invoke(
    "skills:list",
    workspaceId === undefined ? {} : { workspaceId },
  );
}

export function setSkillGlobalEnabled(
  skillId: string,
  enabled: boolean,
): Promise<void> {
  return invoke("skills:setGlobalEnabled", { skillId, enabled });
}

export function setSkillWorkspaceActive(
  skillId: string,
  workspaceId: string,
  active: boolean,
): Promise<void> {
  return invoke("skills:setWorkspaceActive", { skillId, workspaceId, active });
}

export function onSkillsChanged(callback: () => void): () => void {
  return on("skills:changed", callback);
}

export function pickSkillZip(): Promise<{ path: string; name: string } | null> {
  return invoke("skills:pickZip", undefined);
}
export function installSkillZip(
  path: string,
  workspaceId?: string,
  scope?: SkillInstallScope,
): Promise<SkillListItem> {
  return invoke("skills:installZip", {
    path,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(scope === undefined ? {} : { scope }),
  });
}
export function installMarketSkill(
  slug: string,
  version?: string,
  workspaceId?: string,
  scope?: SkillInstallScope,
): Promise<SkillListItem> {
  return invoke("skills:installMarket", {
    slug,
    ...(version === undefined ? {} : { version }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(scope === undefined ? {} : { scope }),
  });
}
export function uninstallSkill(
  skillId: string,
  workspaceId?: string,
  scope?: SkillInstallScope,
): Promise<void> {
  return invoke("skills:uninstall", {
    skillId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(scope === undefined ? {} : { scope }),
  });
}
export function listSkillMarket(
  q?: string,
  category?: string,
): Promise<SkillMarketItem[]> {
  return invoke("skills:marketList", {
    ...(q === undefined ? {} : { q }),
    ...(category === undefined ? {} : { category }),
  });
}
export function listSkillMarketCategories(): Promise<string[]> {
  return invoke("skills:marketCategories", undefined);
}
export function getSkillMarketDetail(
  slug: string,
): Promise<
  SkillMarketItem & {
    versions?: Array<{
      version: string;
      changelog?: string;
      sha256?: string;
      fileSize?: number;
    }>;
  }
> {
  return invoke("skills:marketDetail", { slug });
}
export function listSkillDiagnostics(
  workspaceId?: string,
): Promise<Array<{ path: string; message: string }>> {
  return invoke(
    "skills:diagnostics",
    workspaceId === undefined ? {} : { workspaceId },
  );
}
