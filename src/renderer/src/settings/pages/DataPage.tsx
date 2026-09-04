import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type {
  BackupFrequency,
  StorageStats,
} from "../../../../shared/domain/settings";
import type {
  BackupStatus,
  CleanupAge,
  CleanupPreview,
  ImportPreview,
  RestorePreview,
} from "../../../../shared/domain/data";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Toggle } from "../../components/ui/Toggle";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/cn";
import * as dataService from "../../services/data";
import { useRunIndex } from "../../stores/session";
import type { SettingsPageProps } from "../props";
import { formatBytes, formatCount } from "../format";

type ModalState =
  | { kind: "export" }
  | { kind: "import"; preview: ImportPreview }
  | { kind: "restore"; preview: RestorePreview }
  | { kind: "cleanup"; preview: CleanupPreview; age?: CleanupAge };

/** 设置 › 数据：所有结果都来自主进程数据服务，不在页面里模拟成功状态。 */
export function DataPage({ settings, patch }: SettingsPageProps): ReactNode {
  const { locale, t } = useI18n();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [age, setAge] = useState<CleanupAge>(3);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportPasswordAgain, setExportPasswordAgain] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const running = useRunIndex().length > 0;

  const refresh = useCallback(
    async (initial = false): Promise<void> => {
      if (initial) setLoading(true);
      try {
        const [nextStats, nextBackup] = await Promise.all([
          dataService.getStats(),
          dataService.getBackupStatus(),
        ]);
        setStats(nextStats);
        setBackup(nextBackup);
        if (nextBackup.lastError === null && busy === null) setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        if (initial) setLoading(false);
      }
    },
    [busy],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const closeModal = useCallback((): void => {
    setModal(null);
    setIncludeKeys(false);
    setExportPassword("");
    setExportPasswordAgain("");
    setImportPassword("");
  }, []);

  const run = useCallback(
    async <T,>(
      label: string,
      action: () => Promise<T>,
      success?: (value: T) => string | null,
      refreshAfter = true,
    ): Promise<T | null> => {
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        const value = await action();
        const message = success?.(value);
        if (message !== undefined && message !== null) setNotice(message);
        if (refreshAfter) await refresh();
        return value;
      } catch (err) {
        setError(errorMessage(err));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const chooseDirectory = async (): Promise<void> => {
    const selected = await run("choose-directory", () =>
      dataService.chooseBackupDirectory(),
    );
    if (selected !== null && selected !== undefined)
      setNotice(t("data.backupDirectorySet", { path: selected }));
  };

  const openImportPreview = async (): Promise<void> => {
    const preview = await run("import-preview", () =>
      dataService.importPreview(),
    );
    if (preview !== null && preview !== undefined)
      setModal({ kind: "import", preview });
  };

  const openRestorePreview = async (): Promise<void> => {
    if (running) return;
    const result = await run("restore-preview", () =>
      dataService.restoreBackup(false),
    );
    if (result?.preview !== undefined)
      setModal({ kind: "restore", preview: result.preview });
  };

  const openCleanupPreview = async (
    kind: CleanupPreview["kind"],
    selectedAge?: CleanupAge,
  ): Promise<void> => {
    if (running) return;
    const preview = await run("cleanup-preview", () =>
      dataService.cleanupPreview(kind, selectedAge),
    );
    if (preview !== null)
      setModal({
        kind: "cleanup",
        preview,
        ...(selectedAge === undefined ? {} : { age: selectedAge }),
      });
  };

  const executeImport = async (): Promise<void> => {
    const preview = modal?.kind === "import" ? modal.preview : null;
    if (preview === null) return;
    const result = await run(
      "import-apply",
      () =>
        dataService.importApply(
          preview.hasEncryptedCredentials ? importPassword : undefined,
        ),
      (value) =>
        t("data.imported", {
          imported: formatCount(value.imported),
          overwritten: formatCount(value.overwritten),
        }),
    );
    if (result !== null) closeModal();
  };

  const executeRestore = async (): Promise<void> => {
    if (running || modal?.kind !== "restore") return;
    const result = await run(
      "restore",
      () => dataService.restoreBackup(true),
      (value) => (value?.restored ? t("data.restoreComplete") : null),
    );
    if (result?.restored) closeModal();
  };

  const executeCleanup = async (): Promise<void> => {
    if (running || modal?.kind !== "cleanup") return;
    const target = modal;
    // Different cleanup operations return different result shapes (for example,
    // clearLocalData reports whether the deletion completed).  The page only
    // needs to know whether the service call succeeded.
    let label: string;
    let action: () => Promise<unknown>;
    if (target.preview.kind === "attachments") {
      label = "cleanup-attachments";
      action = dataService.cleanupAttachments;
    } else if (target.preview.kind === "age") {
      label = "cleanup-age";
      action = () => dataService.cleanupByAge(target.age ?? age);
    } else if (target.preview.kind === "history") {
      label = "clear-history";
      action = dataService.clearHistory;
    } else {
      label = "clear-local-data";
      action = () => dataService.clearLocalData(true);
    }
    // `clearLocalData` closes the database and requests app.quit(); querying
    // stats again after it succeeds would race the shutdown path and turn a
    // completed deletion into a spurious error state.
    const result = await run(
      label,
      action,
      undefined,
      target.preview.kind !== "local-data",
    );
    if (result !== null) closeModal();
  };

  const doExport = async (): Promise<void> => {
    if (includeKeys) {
      if (exportPassword.length < 8) {
        setError(t("data.passwordMinLength"));
        return;
      }
      if (exportPassword !== exportPasswordAgain) {
        setError(t("data.passwordMismatch"));
        return;
      }
    }
    const result = await run(
      "export",
      () =>
        dataService.exportData({
          includeEncryptedKeys: includeKeys,
          ...(includeKeys ? { password: exportPassword } : {}),
        }),
      (value) =>
        value === null ? null : t("data.exported", { path: value.path }),
    );
    if (result !== null) closeModal();
  };

  const frequency = settings.data?.backupFrequency ?? "manual";
  const backupDirectory = settings.data?.backupDirectory ?? null;
  const busyNow = busy !== null;
  const riskDisabled = running || busyNow;
  const statValues = useMemo(
    () =>
      [
        [t("data.stat.database"), formatBytes(stats?.dbBytes)],
        [
          t("data.stat.conversationFiles"),
          formatBytes(stats?.conversationBytes),
        ],
        [
          t("data.stat.conversations"),
          t("data.countConversations", {
            count: formatCount(stats?.conversationCount),
          }),
        ],
        [
          t("data.stat.messages"),
          t("data.countMessages", { count: formatCount(stats?.messageCount) }),
        ],
      ] as const,
    [stats, t],
  );
  const frequencyOptions: ReadonlyArray<{
    value: BackupFrequency;
    label: string;
  }> = [
    { value: "manual", label: t("data.frequency.manual") },
    { value: "daily", label: t("data.frequency.daily") },
    { value: "weekly", label: t("data.frequency.weekly") },
  ];
  const ageOptions: ReadonlyArray<{ value: CleanupAge; label: string }> = [
    { value: 3, label: t("data.age.3") },
    { value: 6, label: t("data.age.6") },
    { value: 12, label: t("data.age.12") },
  ];

  return (
    <div className="pb-1">
      <DataSection title={t("data.cloudSync")} className="pt-2">
        <DataRow
          title={t("data.configureCloudSync")}
          description={t("data.cloudSyncHint")}
          last
        >
          <Toggle
            checked={false}
            onChange={() => undefined}
            label={t("data.configureCloudSync")}
            disabled
          />
        </DataRow>
      </DataSection>

      <DataSection title={t("data.migration")}>
        <DataRow title={t("data.export")} description={t("data.exportHint")}>
          <div className="flex items-center gap-2">
            <SelectControl
              ariaLabel={t("data.exportScope")}
              value="all"
              options={[{ value: "all", label: t("data.allData") }]}
            />
            <SelectControl
              ariaLabel={t("data.exportFormat")}
              value="json"
              options={[{ value: "json", label: "JSON" }]}
            />
            <Button
              size="sm"
              className="border border-accent bg-transparent text-accent hover:bg-accent/10"
              icon={<Download size={13} />}
              disabled={busyNow}
              onClick={() => setModal({ kind: "export" })}
            >
              {t("data.export")}
            </Button>
          </div>
        </DataRow>
        <DataRow
          title={t("data.import")}
          description={t("data.importHint")}
          last
        >
          <Button
            size="sm"
            className="border border-accent bg-transparent text-accent hover:bg-accent/10"
            icon={<Upload size={13} />}
            disabled={busyNow}
            onClick={() => {
              void openImportPreview();
            }}
          >
            {t("data.chooseAndImport")}
          </Button>
        </DataRow>
      </DataSection>

      <DataSection title={t("data.backups")}>
        <DataRow
          title={t("data.backupDirectory")}
          description={backupDirectory ?? t("data.notSet")}
        >
          <button
            type="button"
            disabled={busyNow}
            onClick={() => {
              void chooseDirectory();
            }}
            className="app-no-drag inline-flex items-center gap-1.5 text-[12px] text-fg hover:text-accent disabled:opacity-40"
          >
            <FolderOpen size={14} />{" "}
            {backupDirectory
              ? t("data.changeDirectory")
              : t("data.chooseDirectory")}
          </button>
        </DataRow>
        <DataRow
          title={t("data.backupFrequency")}
          description={t("data.backupFrequencyHint")}
        >
          <SelectControl
            ariaLabel={t("data.backupFrequency")}
            value={frequency}
            options={frequencyOptions}
            onChange={(value) =>
              patch({ data: { backupFrequency: value as BackupFrequency } })
            }
            className="w-[98px]"
          />
        </DataRow>
        <DataRow
          title={t("data.lastBackup")}
          description={
            backup?.lastError
              ? t("data.backupFailed", { error: backup.lastError })
              : formatDate(
                  backup?.lastBackupAt,
                  locale,
                  t("data.neverBackedUp"),
                )
          }
        >
          <Button
            size="sm"
            disabled={backupDirectory === null || busyNow}
            icon={<HardDrive size={13} />}
            onClick={() => {
              void run(
                "backup",
                () => dataService.createBackup(true),
                () => t("data.backupComplete"),
              );
            }}
          >
            {t("data.backupNow")}
          </Button>
        </DataRow>
        <DataRow
          title={t("data.restoreBackup")}
          description={t("data.restoreBackupHint")}
          last
        >
          <Button
            size="sm"
            className="border border-accent bg-transparent text-accent hover:bg-accent/10"
            icon={<RefreshCw size={13} />}
            disabled={riskDisabled}
            onClick={() => {
              void openRestorePreview();
            }}
          >
            {t("data.chooseBackup")}
          </Button>
        </DataRow>
      </DataSection>

      <DataSection title={t("data.storage")}>
        <div className="grid grid-cols-4 gap-2 pb-2 pt-3">
          {statValues.map(([label, value]) => (
            <Stat key={label} label={label} value={loading ? "…" : value} />
          ))}
        </div>
        <DataRow
          title={t("data.dataDirectory")}
          description={stats?.dataDirectory ?? t("data.dataDirectoryHint")}
        >
          <Button
            size="sm"
            icon={<FolderOpen size={13} />}
            disabled={busyNow}
            onClick={() => {
              void run(
                "open-directory",
                () => dataService.openDataDirectory(),
                () => t("data.directoryOpened"),
              );
            }}
          >
            {t("data.openDirectory")}
          </Button>
        </DataRow>
        <DataRow
          title={t("data.optimizeStorage")}
          description={t("data.optimizeStorageHint")}
        >
          <Button
            size="sm"
            icon={<HardDrive size={13} />}
            disabled={busyNow}
            onClick={() => {
              void run(
                "vacuum",
                () => dataService.vacuum(),
                () => t("data.storageOptimized"),
              );
            }}
          >
            {t("data.optimize")}
          </Button>
        </DataRow>
        <DataRow
          title={t("data.cleanupAttachments")}
          description={t("data.cleanupAttachmentsHint")}
        >
          <Button
            size="sm"
            icon={<Trash2 size={13} />}
            disabled={riskDisabled}
            onClick={() => {
              void openCleanupPreview("attachments");
            }}
          >
            {t("data.cleanup")}
          </Button>
        </DataRow>
        <DataRow title={t("data.cleanupRange")}>
          <div className="flex items-center gap-2">
            <SelectControl
              ariaLabel={t("data.cleanupRange")}
              value={String(age)}
              options={ageOptions.map((x) => ({
                value: String(x.value),
                label: x.label,
              }))}
              className="w-[114px]"
              onChange={(value) => setAge(Number(value) as CleanupAge)}
            />
            <Button
              size="sm"
              icon={<Trash2 size={13} />}
              disabled={riskDisabled}
              onClick={() => {
                void openCleanupPreview("age", age);
              }}
            >
              {t("data.cleanup")}
            </Button>
          </div>
        </DataRow>
        <DataRow
          title={t("data.clearHistory")}
          description={t("data.clearHistoryHint")}
          descriptionTone="danger"
          last
        >
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={13} />}
            disabled={riskDisabled}
            onClick={() => {
              void openCleanupPreview("history");
            }}
          >
            {t("data.clearChats")}
          </Button>
        </DataRow>
      </DataSection>

      <DataSection title={t("data.clearLocal")} className="mb-1">
        <DataRow
          title={t("data.deleteAndQuit")}
          description={t("data.deleteAndQuitHint")}
          last
        >
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={13} />}
            disabled={riskDisabled}
            onClick={() => {
              void openCleanupPreview("local-data");
            }}
          >
            {t("data.deleteAndQuit")}
          </Button>
        </DataRow>
      </DataSection>

      {busyNow && (
        <p
          className="flex items-center gap-1.5 px-1 pb-2 text-[11.5px] text-fg-muted"
          role="status"
        >
          <Loader2 size={12} className="animate-spin" />
          {t("data.processing")}
        </p>
      )}
      {running && (
        <p
          className="flex items-center gap-1.5 px-1 pb-2 text-[11.5px] text-fg-muted"
          role="status"
        >
          <AlertTriangle size={12} />
          {t("data.runningAgents")}
        </p>
      )}
      {error !== null && (
        <p
          className="flex items-start gap-1.5 px-1 pb-2 text-[11.5px] text-danger"
          role="alert"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      {notice !== null && (
        <p
          className="flex items-start gap-1.5 px-1 pb-2 text-[11.5px] text-fg-muted"
          role="status"
        >
          <Check size={13} className="mt-0.5 shrink-0 text-accent" />
          {notice}
        </p>
      )}

      <ExportDialog
        open={modal?.kind === "export"}
        includeKeys={includeKeys}
        password={exportPassword}
        passwordAgain={exportPasswordAgain}
        busy={busyNow}
        onIncludeKeys={setIncludeKeys}
        onPassword={setExportPassword}
        onPasswordAgain={setExportPasswordAgain}
        onClose={closeModal}
        onExport={() => {
          void doExport();
        }}
      />
      <ImportDialog
        open={modal?.kind === "import"}
        preview={modal?.kind === "import" ? modal.preview : null}
        password={importPassword}
        busy={busyNow}
        onPassword={setImportPassword}
        onClose={closeModal}
        onApply={() => {
          void executeImport();
        }}
      />
      <RestoreDialog
        open={modal?.kind === "restore"}
        preview={modal?.kind === "restore" ? modal.preview : null}
        busy={busyNow}
        onClose={closeModal}
        onApply={() => {
          void executeRestore();
        }}
      />
      <CleanupDialog
        open={modal?.kind === "cleanup"}
        preview={modal?.kind === "cleanup" ? modal.preview : null}
        busy={busyNow}
        onClose={closeModal}
        onApply={() => {
          void executeCleanup();
        }}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : String(error);
}

function formatDate(
  value: number | null | undefined,
  locale: string,
  fallback: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return fallback;
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function DataSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section
      className={cn(
        "mb-3.5 overflow-hidden rounded-[18px] border border-border bg-surface-field px-4",
        className,
      )}
    >
      <h3 className="pt-4 pb-0.5 text-[13px] text-fg">{title}</h3>
      {children}
    </section>
  );
}

function DataRow({
  title,
  description,
  children,
  descriptionTone,
  last = false,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  descriptionTone?: "danger";
  last?: boolean;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex min-h-[62px] items-center gap-5 py-3",
        !last && "border-b border-hairline",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-fg">{title}</p>
        {description !== undefined && (
          <p
            className={cn(
              "mt-1 text-[11.5px] leading-[1.45] text-fg-muted",
              descriptionTone === "danger" && "text-danger",
            )}
          >
            {description}
          </p>
        )}
      </div>
      {children !== undefined && (
        <div className="flex shrink-0 justify-end">{children}</div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex h-[60px] flex-col items-center justify-center rounded-[11px] bg-tint">
      <span className="text-[10.5px] text-fg-muted">{label}</span>
      <strong className="mt-1 text-[14px] font-normal text-fg">{value}</strong>
    </div>
  );
}

function SelectControl({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange?: (value: string) => void;
  ariaLabel: string;
  className?: string;
}): ReactNode {
  return (
    <label className={cn("app-no-drag relative block w-[108px]", className)}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="selectable h-7 w-full appearance-none rounded-pill border border-border bg-surface-field py-0 pr-7 pl-3 text-[12px] text-fg outline-none hover:bg-tint focus:border-accent"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        size={13}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-faint"
      />
    </label>
  );
}

function ExportDialog({
  open,
  includeKeys,
  password,
  passwordAgain,
  busy,
  onIncludeKeys,
  onPassword,
  onPasswordAgain,
  onClose,
  onExport,
}: {
  open: boolean;
  includeKeys: boolean;
  password: string;
  passwordAgain: string;
  busy: boolean;
  onIncludeKeys: (value: boolean) => void;
  onPassword: (value: string) => void;
  onPasswordAgain: (value: string) => void;
  onClose: () => void;
  onExport: () => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("data.exportData")}
      description={t("data.exportDialogHint")}
      width={500}
      footer={
        <>
          <Button size="sm" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={onExport}
            icon={
              busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )
            }
          >
            {t("data.exportJson")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-[10px] bg-tint px-3 py-2.5 text-[12px] leading-[1.6] text-fg-muted">
          {t("data.exportContents")}
        </div>
        <div className="flex items-center justify-between gap-4 rounded-[10px] border border-border px-3 py-2.5">
          <div>
            <p className="text-[12.5px] text-fg">
              {t("data.includeEncryptedCredentials")}
            </p>
            <p className="mt-0.5 text-[11px] text-fg-faint">
              {t("data.encryptionHint")}
            </p>
          </div>
          <Toggle
            checked={includeKeys}
            onChange={onIncludeKeys}
            label={t("data.includeEncryptedCredentials")}
          />
        </div>
        {includeKeys && (
          <div className="space-y-2">
            <PasswordField
              label={t("data.exportPassword")}
              value={password}
              onChange={onPassword}
              placeholder={t("data.passwordAtLeast8")}
            />
            <PasswordField
              label={t("data.confirmPassword")}
              value={passwordAgain}
              onChange={onPasswordAgain}
              placeholder={t("data.confirmExportPassword")}
            />
            <p className="text-[11px] text-fg-faint">
              {t("data.passwordStorageHint")}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ImportDialog({
  open,
  preview,
  password,
  busy,
  onPassword,
  onClose,
  onApply,
}: {
  open: boolean;
  preview: ImportPreview | null;
  password: string;
  busy: boolean;
  onPassword: (value: string) => void;
  onClose: () => void;
  onApply: () => void;
}): ReactNode {
  if (preview === null) return null;
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("data.importPreview")}
      description={preview.path}
      width={520}
      footer={
        <>
          <Button size="sm" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="accent"
            disabled={
              busy || (preview.hasEncryptedCredentials && password.length < 8)
            }
            onClick={onApply}
            icon={
              busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )
            }
          >
            {t("data.confirmImport")}
          </Button>
        </>
      }
    >
      <PreviewCounts
        rows={[
          [t("data.workspace"), preview.workspaceCount],
          [t("data.conversations"), preview.sessionCount],
          [t("data.messages"), preview.messageCount],
          [t("data.providers"), preview.providerCount],
          [t("data.modelAliases"), preview.aliasCount],
          [t("data.mcpServers"), preview.mcpServerCount],
        ]}
      />
      <p className="mt-3 text-[11.5px] leading-[1.6] text-fg-muted">
        {t("data.importSummary", {
          created: preview.newCount,
          updated: preview.overwriteCount,
          skipped: preview.skippedCount,
        })}
      </p>
      {preview.hasEncryptedCredentials && (
        <div className="mt-3 rounded-[10px] border border-border px-3 py-2.5">
          <p className="text-[12.5px] text-fg">{t("data.encryptedFile")}</p>
          <p className="mt-1 text-[11px] text-fg-faint">
            {t("data.importPasswordHint")}
          </p>
          <input
            type="password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            placeholder={t("data.importPassword")}
            aria-label={t("data.importPassword")}
            className="selectable mt-2 h-8 w-full rounded-[8px] border border-border bg-surface-field px-2.5 text-[13px] text-fg outline-none focus:border-accent"
          />
        </div>
      )}
    </Dialog>
  );
}

function RestoreDialog({
  open,
  preview,
  busy,
  onClose,
  onApply,
}: {
  open: boolean;
  preview: RestorePreview | null;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}): ReactNode {
  if (preview === null) return null;
  const { locale, t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("data.restoreTitle")}
      description={preview.path}
      width={500}
      footer={
        <>
          <Button size="sm" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={onApply}
            icon={
              busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )
            }
          >
            {t("data.confirmRestore")}
          </Button>
        </>
      }
    >
      <div className="rounded-[10px] border border-border px-3 py-2.5 text-[12px] leading-[1.6] text-fg-muted">
        <p>
          {t("data.backupCreatedAt", {
            date: formatDate(preview.manifest.createdAt, locale, ""),
          })}
        </p>
        <p>
          {t("data.restoreContents", {
            sessions: formatCount(preview.sessionCount),
            messages: formatCount(preview.messageCount),
          })}
        </p>
        <p>{t("data.restoreHint")}</p>
      </div>
    </Dialog>
  );
}

function CleanupDialog({
  open,
  preview,
  busy,
  onClose,
  onApply,
}: {
  open: boolean;
  preview: CleanupPreview | null;
  busy: boolean;
  onClose: () => void;
  onApply: () => void;
}): ReactNode {
  if (preview === null) return null;
  const { t } = useI18n();
  const dangerous = preview.kind === "history" || preview.kind === "local-data";
  const title =
    preview.kind === "attachments"
      ? t("data.cleanupAttachments")
      : preview.kind === "age"
        ? t("data.cleanupByAge")
        : preview.kind === "history"
          ? t("data.clearHistory")
          : t("data.deleteAndQuit");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={t("data.confirmCleanupHint")}
      width={500}
      footer={
        <>
          <Button size="sm" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={onApply}
            icon={
              busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )
            }
          >
            {preview.kind === "local-data"
              ? t("data.deletePermanentlyAndQuit")
              : t("data.confirmCleanup")}
          </Button>
        </>
      }
    >
      {dangerous && (
        <div className="mb-3 flex items-start gap-2 rounded-[10px] bg-danger/10 px-3 py-2.5 text-[12px] leading-[1.6] text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t("data.irreversible")}
          {preview.kind === "local-data"
            ? t("data.localDataRetention")
            : t("data.historyRetention")}
        </div>
      )}
      <PreviewCounts
        rows={[
          [t("data.conversations"), preview.sessionCount],
          [t("data.messages"), preview.messageCount],
          [t("data.attachments"), preview.attachmentCount],
        ]}
      />
      <p className="mt-3 text-[12px] text-fg-muted">
        {t("data.reclaimableSpace")}{" "}
        <span className="text-fg">{formatBytes(preview.bytes)}</span>
      </p>
      {preview.undeletable.length > 0 && (
        <p className="mt-2 text-[11.5px] leading-[1.6] text-danger">
          {t("data.undeletable", { count: preview.undeletable.length })}
        </p>
      )}
    </Dialog>
  );
}

function PreviewCounts({
  rows,
}: {
  rows: ReadonlyArray<readonly [string, number]>;
}): ReactNode {
  return (
    <div className="grid grid-cols-3 gap-2">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="rounded-[9px] bg-tint px-2 py-2 text-center"
        >
          <div className="text-[11px] text-fg-faint">{label}</div>
          <strong className="mt-0.5 block text-[14px] font-normal text-fg">
            {formatCount(value)}
          </strong>
        </div>
      ))}
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] text-fg-muted">{label}</span>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="selectable h-8 w-full rounded-[8px] border border-border bg-surface-field px-2.5 text-[13px] text-fg outline-none focus:border-accent"
      />
    </label>
  );
}
