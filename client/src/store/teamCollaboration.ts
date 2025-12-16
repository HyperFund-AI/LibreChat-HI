import { atom } from 'recoil';

export interface TeamThinkingStep {
  id: string;
  agent: string;
  role?: string;
  action:
    | 'analyzing'
    | 'planned'
    | 'working'
    | 'completed'
    | 'synthesizing'
    | 'complete'
    | 'thinking'
    | 'collaboration'
    | 'asking_user'
    | 'requesting_colleague'
    | 'continuing';
  message: string;
  thinking?: string; // Full thinking process in Markdown format
  collaboration?: string; // Team conversation content (Markdown)
  timestamp: number;
}

export interface TeamCollaborationState {
  isActive: boolean;
  conversationId: string | null;
  steps: TeamThinkingStep[];
  currentAgent: string | null;
  phase: 'idle' | 'planning' | 'specialist-work' | 'synthesis' | 'complete';
  agentThinking: Record<string, string>; // Map of agent name -> current thinking process (Markdown)
  agentCollaboration: Record<string, string>; // Map of agent name -> current collaboration conversation (Markdown)
}

const defaultState: TeamCollaborationState = {
  isActive: false,
  conversationId: null,
  steps: [],
  currentAgent: null,
  phase: 'idle',
  agentThinking: {},
  agentCollaboration: {},
};

export const teamCollaborationAtom = atom<TeamCollaborationState>({
  key: 'teamCollaboration',
  default: defaultState,
});

// Helper to reset the state
export const resetTeamCollaboration = (): TeamCollaborationState => defaultState;
