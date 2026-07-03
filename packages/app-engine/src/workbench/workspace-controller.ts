import {
  getCurrentWorkspaceIdentity,
  listProfileWorkspaces,
  switchBrowserWorkspace,
  type CurrentWorkspaceIdentity,
  type WorkspaceInfo,
} from "../profile.js";
import type { Profile } from "../config.js";

export interface WorkbenchWorkspaceController {
  load(profileName?: string): Promise<WorkbenchWorkspaceSnapshot>;
  switchWorkspace(profileName: string | undefined, workspaceId: string, authType: Profile["auth"]["type"]): Promise<WorkbenchWorkspaceSnapshot>;
}

export interface WorkbenchWorkspaceSnapshot {
  authType: Profile["auth"]["type"];
  current: WorkbenchWorkspaceContext;
  workspaces: WorkbenchWorkspaceItem[];
  switchable: boolean;
}

export interface WorkbenchWorkspaceContext {
  apiKeyId?: string;
  authMethod?: string;
  id: string;
  name: string;
  role: string;
  userId: string;
  userStatus?: string;
}

export interface WorkbenchWorkspaceItem {
  id: string;
  membershipStatus: string;
  name: string;
  role: string;
  status: string;
}

export interface WorkbenchWorkspaceControllerOptions {
  getCurrentWorkspaceIdentityImpl?: typeof getCurrentWorkspaceIdentity;
  listProfileWorkspacesImpl?: typeof listProfileWorkspaces;
  switchBrowserWorkspaceImpl?: typeof switchBrowserWorkspace;
}

export function createWorkbenchWorkspaceController(
  options: WorkbenchWorkspaceControllerOptions = {},
): WorkbenchWorkspaceController {
  const getCurrentWorkspaceIdentityImpl = options.getCurrentWorkspaceIdentityImpl ?? getCurrentWorkspaceIdentity;
  const listProfileWorkspacesImpl = options.listProfileWorkspacesImpl ?? listProfileWorkspaces;
  const switchBrowserWorkspaceImpl = options.switchBrowserWorkspaceImpl ?? switchBrowserWorkspace;

  return {
    async load(profileName) {
      const current = await getCurrentWorkspaceIdentityImpl(profileName);
      const workspaces = await listProfileWorkspacesImpl(profileName);
      return workspaceSnapshot(current, workspaces);
    },

    async switchWorkspace(profileName, workspaceId, authType) {
      if (authType !== "browser") {
        throw new Error("API key profiles are bound to one workspace. Switch profile or use a browser-auth profile to change workspace.");
      }
      const workspacesBeforeSwitch = await listProfileWorkspacesImpl(profileName);
      const target = workspacesBeforeSwitch.find((workspace) => workspace.id === workspaceId);
      if (!target) {
        throw new Error(`Workspace not found for this profile: ${workspaceId}`);
      }
      if (!isActiveMembership(target)) {
        const status = target.membershipStatus || "unknown";
        throw new Error(`Workspace switch requires active membership. ${target.name} is ${status}.`);
      }
      const current = await switchBrowserWorkspaceImpl(profileName, workspaceId);
      const workspaces = await listProfileWorkspacesImpl(profileName);
      return workspaceSnapshot(current, workspaces);
    },
  };
}

function isActiveMembership(workspace: WorkspaceInfo) {
  return !workspace.membershipStatus || workspace.membershipStatus.toLowerCase() === "active";
}

function workspaceSnapshot(
  current: CurrentWorkspaceIdentity,
  workspaces: WorkspaceInfo[],
): WorkbenchWorkspaceSnapshot {
  const authType = current.apiKeyId ? "api_key" : "browser";
  return {
    authType,
    current: {
      apiKeyId: current.apiKeyId,
      authMethod: current.authMethod,
      id: current.workspaceId,
      name: current.workspaceName || current.workspaceId,
      role: current.workspaceRole,
      userId: current.userId,
      userStatus: current.userStatus,
    },
    switchable: authType === "browser",
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      membershipStatus: workspace.membershipStatus,
      name: workspace.name,
      role: workspace.role,
      status: workspace.status,
    })),
  };
}
