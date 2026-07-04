import { html, nothing } from "lit";
import type { ApiDirectoryListing } from "@pi-web-app/shared";

type ProjectSessionDialogOptions = {
  getInitialProjectPath: () => string | undefined;
  requestRender: () => void;
  listDirectories: (path: string | undefined) => Promise<ApiDirectoryListing>;
  createSession: (projectPath: string) => Promise<boolean>;
  onSessionCreated: (projectPath: string) => void;
};

export class ProjectSessionDialog {
  private isCreateDialogOpen = false;
  private isDirectoryBrowserOpen = false;
  private newProjectPath = "";
  private newProjectError: string | undefined;
  private directoryBrowserPath = "";
  private directoryBrowserLoadedPath: string | undefined;
  private directoryBrowserParentPath: string | undefined;
  private directoryBrowserEntries: ApiDirectoryListing["directories"] = [];
  private directoryBrowserError: string | undefined;
  private isLoadingProjectDirectories = false;
  private isCreatingProjectSession = false;
  private directoryBrowserLoadRequestId = 0;

  constructor(private readonly options: ProjectSessionDialogOptions) {}

  open() {
    this.isCreateDialogOpen = true;
    this.newProjectPath = this.options.getInitialProjectPath() ?? this.newProjectPath;
    this.newProjectError = undefined;
    this.options.requestRender();
  }

  render() {
    if (!this.isCreateDialogOpen && !this.isDirectoryBrowserOpen) return nothing;
    return html`
      ${this.isCreateDialogOpen ? this.renderCreateDialog() : nothing}
      ${this.isDirectoryBrowserOpen ? this.renderDirectoryBrowser() : nothing}
    `;
  }

  private closeCreateDialog() {
    if (this.isCreatingProjectSession) {
      return;
    }

    this.isCreateDialogOpen = false;
    this.isDirectoryBrowserOpen = false;
    this.newProjectError = undefined;
    this.options.requestRender();
  }

  private openDirectoryBrowser() {
    this.isDirectoryBrowserOpen = true;
    this.directoryBrowserPath = (this.newProjectPath.trim() || this.options.getInitialProjectPath()) ?? "";
    this.directoryBrowserLoadedPath = undefined;
    this.directoryBrowserParentPath = undefined;
    this.directoryBrowserEntries = [];
    this.directoryBrowserError = undefined;
    this.options.requestRender();
    void this.loadProjectDirectories(this.directoryBrowserPath);
  }

  private closeDirectoryBrowser() {
    this.isDirectoryBrowserOpen = false;
    this.directoryBrowserError = undefined;
    this.options.requestRender();
  }

  private async loadProjectDirectories(path?: string) {
    const requestId = ++this.directoryBrowserLoadRequestId;
    const requestedPath = path?.trim() || undefined;
    this.directoryBrowserError = undefined;
    this.directoryBrowserLoadedPath = undefined;
    this.directoryBrowserParentPath = undefined;
    this.directoryBrowserEntries = [];
    this.isLoadingProjectDirectories = true;
    this.options.requestRender();

    try {
      const response = await this.options.listDirectories(requestedPath);
      if (requestId !== this.directoryBrowserLoadRequestId) {
        return;
      }

      this.directoryBrowserPath = response.path;
      this.directoryBrowserLoadedPath = response.path;
      this.directoryBrowserParentPath = response.parentPath;
      this.directoryBrowserEntries = response.directories;
    } catch (error) {
      if (requestId === this.directoryBrowserLoadRequestId) {
        this.directoryBrowserError = getErrorMessage(error);
      }
    } finally {
      if (requestId === this.directoryBrowserLoadRequestId) {
        this.isLoadingProjectDirectories = false;
        this.options.requestRender();
      }
    }
  }

  private updateDirectoryBrowserPath(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    this.directoryBrowserPath = target.value;
    this.directoryBrowserError = undefined;
    this.options.requestRender();
  }

  private handleDirectoryBrowserPathKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void this.loadProjectDirectories(this.directoryBrowserPath);
  }

  private useDirectoryBrowserPath() {
    const directoryPath = this.directoryBrowserPath.trim();
    if (!directoryPath) {
      this.directoryBrowserError = "Project directory is required.";
      this.options.requestRender();
      return;
    }

    if (directoryPath !== this.directoryBrowserLoadedPath) {
      this.directoryBrowserError = "Open this directory first.";
      this.options.requestRender();
      return;
    }

    this.newProjectPath = directoryPath;
    this.newProjectError = undefined;
    this.isDirectoryBrowserOpen = false;
    this.options.requestRender();
  }

  private updateNewProjectPath(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    this.newProjectPath = target.value;
    this.newProjectError = undefined;
    this.options.requestRender();
  }

  private handleCreateProjectPathKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void this.createProjectSession();
  }

  private async createProjectSession() {
    const projectPath = this.newProjectPath.trim();
    if (!projectPath) {
      this.newProjectError = "Project directory is required.";
      this.options.requestRender();
      return;
    }

    this.newProjectError = undefined;
    this.isCreatingProjectSession = true;
    this.options.requestRender();

    try {
      const opened = await this.options.createSession(projectPath);
      if (!opened) {
        return;
      }

      this.options.onSessionCreated(projectPath);
      this.isCreateDialogOpen = false;
      this.isDirectoryBrowserOpen = false;
    } catch (error) {
      if (!isAbortError(error)) {
        this.newProjectError = getErrorMessage(error);
      }
    } finally {
      this.isCreatingProjectSession = false;
      this.options.requestRender();
    }
  }

  private renderCreateDialog() {
    return html`
      <div class="pp-dialog-overlay" @click=${() => this.closeCreateDialog()}>
        <div class="pp-dialog" @click=${(event: Event) => event.stopPropagation()}>
          <div class="pp-dialog-title">Open project</div>
          <div class="pp-dialog-subtitle">
            Choose a directory on the machine running Pi Web. You can paste a path or browse it here.
          </div>
          <div class="pp-dialog-section">
            <div class="pp-dialog-section-title">Project directory</div>
            <div class="pp-dialog-section-desc">The new session will use this directory as its working tree.</div>
            <div style="display:flex; gap:0.5rem; align-items:center;">
              <input
                class="pp-dialog-input"
                type="text"
                placeholder="/path/to/project"
                .value=${this.newProjectPath}
                @input=${(event: Event) => this.updateNewProjectPath(event)}
                @keydown=${(event: KeyboardEvent) => this.handleCreateProjectPathKeyDown(event)}
              />
              <button class="pp-dialog-btn" @click=${() => this.openDirectoryBrowser()} ?disabled=${this.isCreatingProjectSession}>
                Browse
              </button>
            </div>
            ${this.newProjectError
              ? html`<div class="pp-error" style="margin-top:0.75rem;">${this.newProjectError}</div>`
              : nothing}
          </div>
          <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
            <button class="pp-dialog-btn" @click=${() => this.closeCreateDialog()} ?disabled=${this.isCreatingProjectSession}>
              Cancel
            </button>
            <button class="pp-dialog-btn primary" @click=${() => void this.createProjectSession()} ?disabled=${this.isCreatingProjectSession}>
              ${this.isCreatingProjectSession ? "Creating…" : "Create session"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderDirectoryBrowser() {
    const canUseDirectory = !this.isLoadingProjectDirectories
      && this.directoryBrowserPath.trim() === this.directoryBrowserLoadedPath;

    return html`
      <div class="pp-dialog-overlay" @click=${() => this.closeDirectoryBrowser()}>
        <div class="pp-dialog pp-directory-browser-dialog" @click=${(event: Event) => event.stopPropagation()}>
          <div class="pp-dialog-title">Browse project directory</div>
          <div class="pp-dialog-subtitle">
            This browser lists directories on the Pi Web server, so the selected path works for the agent session.
          </div>

          <div class="pp-directory-browser-path-row">
            <input
              class="pp-dialog-input pp-directory-browser-path-input"
              type="text"
              aria-label="Directory path"
              .value=${this.directoryBrowserPath}
              @input=${(event: Event) => this.updateDirectoryBrowserPath(event)}
              @keydown=${(event: KeyboardEvent) => this.handleDirectoryBrowserPathKeyDown(event)}
            />
            <button class="pp-dialog-btn" @click=${() => void this.loadProjectDirectories(this.directoryBrowserPath)} ?disabled=${this.isLoadingProjectDirectories}>
              Go
            </button>
          </div>

          <div class="pp-directory-browser-toolbar">
            <button
              class="pp-dialog-btn"
              @click=${() => this.directoryBrowserParentPath ? void this.loadProjectDirectories(this.directoryBrowserParentPath) : undefined}
              ?disabled=${this.isLoadingProjectDirectories || !this.directoryBrowserParentPath}
            >Up</button>
          </div>

          ${this.directoryBrowserError
            ? html`<div class="pp-error" style="margin-bottom:0.75rem;">${this.directoryBrowserError}</div>`
            : nothing}

          <div class="pp-directory-browser-list" aria-label="Directories">
            ${this.isLoadingProjectDirectories
              ? html`<div class="pp-dialog-empty">Loading directories…</div>`
              : this.directoryBrowserEntries.length > 0
                ? this.directoryBrowserEntries.map((entry) => html`
                    <button class="pp-dialog-item pp-directory-browser-entry" @click=${() => void this.loadProjectDirectories(entry.path)}>
                      <div class="pp-dialog-item-title">${entry.name}</div>
                      <div class="pp-dialog-item-desc">${entry.path}</div>
                    </button>
                  `)
                : html`<div class="pp-dialog-empty">No subdirectories.</div>`}
          </div>

          <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
            <button class="pp-dialog-btn" @click=${() => this.closeDirectoryBrowser()}>Cancel</button>
            <button class="pp-dialog-btn primary" @click=${() => this.useDirectoryBrowserPath()} ?disabled=${!canUseDirectory}>
              Use this directory
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
