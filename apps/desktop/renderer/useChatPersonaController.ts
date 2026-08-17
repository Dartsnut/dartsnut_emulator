import { useCallback, useReducer } from "react";
import {
  normalizeAgentProfileId,
  type AgentProfileId,
  type BootstrapState
} from "@dartsnut/shared-ipc";

type PersonaStateBase = { generation: number };

export type ChatPersonaState =
  | (PersonaStateBase & { phase: "booting" })
  | (PersonaStateBase & { phase: "idle"; projectId: string | null })
  | (PersonaStateBase & { phase: "picking"; projectId: string | null })
  | (PersonaStateBase & { phase: "creating-project"; profileId: AgentProfileId })
  | (PersonaStateBase & { phase: "creating-chat"; projectId: string; profileId: AgentProfileId })
  | (PersonaStateBase & { phase: "hydrating"; chatId: string })
  | (PersonaStateBase & { phase: "ready"; chatId: string; profileId: AgentProfileId });

export type ChatPersonaAction =
  | { type: "bootstrap"; activeProjectId: string | null; activeChatId: string | null }
  | { type: "new-chat"; projectId: string | null }
  | { type: "profile-selected"; profileId: AgentProfileId }
  | { type: "creation-succeeded"; chatId: string; profileId: AgentProfileId }
  | { type: "creation-failed" }
  | { type: "project-creation-cancelled" }
  | { type: "hydrated"; chatId: string; generation: number; profileId: unknown }
  | { type: "hydration-failed"; chatId: string; generation: number }
  | { type: "active-chat-archived"; projectId: string | null };

export const INITIAL_CHAT_PERSONA_STATE: ChatPersonaState = {
  phase: "booting",
  generation: 0
};

export function readyAgentProfileId(
  state: ChatPersonaState,
  activeChatId: string | null | undefined
): AgentProfileId | null {
  return state.phase === "ready" && state.chatId === activeChatId ? state.profileId : null;
}

export function chatPersonaReducer(
  state: ChatPersonaState,
  action: ChatPersonaAction
): ChatPersonaState {
  switch (action.type) {
    case "bootstrap": {
      if (action.activeChatId) {
        if (
          (state.phase === "ready" || state.phase === "hydrating") &&
          state.chatId === action.activeChatId
        ) {
          return state;
        }
        if (state.phase === "creating-chat" || state.phase === "creating-project") {
          return state;
        }
        return {
          phase: "hydrating",
          generation: state.generation + 1,
          chatId: action.activeChatId
        };
      }

      if (state.phase === "booting") {
        return action.activeProjectId
          ? { phase: "idle", generation: 1, projectId: action.activeProjectId }
          : { phase: "picking", generation: 1, projectId: null };
      }
      if (
        state.phase === "picking" ||
        state.phase === "creating-chat" ||
        state.phase === "creating-project"
      ) {
        return state;
      }
      if (state.phase === "idle" && state.projectId === action.activeProjectId) {
        return state;
      }
      return {
        phase: "idle",
        generation: state.generation + 1,
        projectId: action.activeProjectId
      };
    }
    case "new-chat":
      return {
        phase: "picking",
        generation: state.generation + 1,
        projectId: action.projectId
      };
    case "profile-selected":
      if (state.phase !== "picking") return state;
      return state.projectId
        ? {
            phase: "creating-chat",
            generation: state.generation,
            projectId: state.projectId,
            profileId: action.profileId
          }
        : {
            phase: "creating-project",
            generation: state.generation,
            profileId: action.profileId
          };
    case "creation-succeeded":
      return {
        phase: "ready",
        generation: state.generation + 1,
        chatId: action.chatId,
        profileId: action.profileId
      };
    case "creation-failed":
      if (state.phase === "creating-chat") {
        return {
          phase: "picking",
          generation: state.generation + 1,
          projectId: state.projectId
        };
      }
      if (state.phase === "creating-project") {
        return {
          phase: "picking",
          generation: state.generation + 1,
          projectId: null
        };
      }
      return state;
    case "project-creation-cancelled":
      if (state.phase !== "creating-project") return state;
      return {
        phase: "picking",
        generation: state.generation + 1,
        projectId: null
      };
    case "hydrated":
      if (
        state.phase !== "hydrating" ||
        state.chatId !== action.chatId ||
        state.generation !== action.generation
      ) {
        return state;
      }
      return {
        phase: "ready",
        generation: state.generation,
        chatId: state.chatId,
        profileId: normalizeAgentProfileId(action.profileId)
      };
    case "hydration-failed":
      if (
        state.phase !== "hydrating" ||
        state.chatId !== action.chatId ||
        state.generation !== action.generation
      ) {
        return state;
      }
      return {
        phase: "ready",
        generation: state.generation,
        chatId: state.chatId,
        profileId: "export"
      };
    case "active-chat-archived":
      return {
        phase: "idle",
        generation: state.generation + 1,
        projectId: action.projectId
      };
  }
}

export function useChatPersonaController() {
  const [state, dispatch] = useReducer(chatPersonaReducer, INITIAL_CHAT_PERSONA_STATE);

  const syncBootstrap = useCallback((bootstrap: Pick<BootstrapState, "activeProjectId" | "activeChatId">) => {
    dispatch({
      type: "bootstrap",
      activeProjectId: bootstrap.activeProjectId,
      activeChatId: bootstrap.activeChatId
    });
  }, []);
  const startNewChat = useCallback((projectId: string | null) => {
    dispatch({ type: "new-chat", projectId });
  }, []);
  const selectProfile = useCallback((profileId: AgentProfileId) => {
    dispatch({ type: "profile-selected", profileId });
  }, []);
  const completeCreation = useCallback((chatId: string, profileId: AgentProfileId) => {
    dispatch({ type: "creation-succeeded", chatId, profileId });
  }, []);
  const failCreation = useCallback(() => dispatch({ type: "creation-failed" }), []);
  const cancelProjectCreation = useCallback(
    () => dispatch({ type: "project-creation-cancelled" }),
    []
  );
  const completeHydration = useCallback(
    (chatId: string, generation: number, profileId: unknown) => {
      dispatch({ type: "hydrated", chatId, generation, profileId });
    },
    []
  );
  const failHydration = useCallback((chatId: string, generation: number) => {
    dispatch({ type: "hydration-failed", chatId, generation });
  }, []);
  const archiveActiveChat = useCallback((projectId: string | null) => {
    dispatch({ type: "active-chat-archived", projectId });
  }, []);

  return {
    state,
    syncBootstrap,
    startNewChat,
    selectProfile,
    completeCreation,
    failCreation,
    cancelProjectCreation,
    completeHydration,
    failHydration,
    archiveActiveChat
  };
}
