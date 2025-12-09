import { atom } from 'recoil';

export interface TeamThinkingStep {
  id: string;
  agent: string;
  role?: string;
  action: 'analyzing' | 'planned' | 'working' | 'completed' | 'synthesizing' | 'complete';
  message: string;
  timestamp: number;
}

export interface TeamCollaborationState {
  isActive: boolean;
  conversationId: string | null;
  steps: TeamThinkingStep[];
  currentAgent: string | null;
  phase: 'idle' | 'planning' | 'specialist-work' | 'synthesis' | 'complete';
}

const defaultState: TeamCollaborationState = {
  isActive: false,
  conversationId: null,
  steps: [],
  currentAgent: null,
  phase: 'idle',
};

export const teamCollaborationAtom = atom<TeamCollaborationState>({
  key: 'teamCollaboration',
  default: defaultState,
});

// Helper to reset the state
export const resetTeamCollaboration = (): TeamCollaborationState => defaultState;

