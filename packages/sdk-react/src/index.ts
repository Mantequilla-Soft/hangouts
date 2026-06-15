// Re-export core types and utilities
export {
  HangoutsApiClient,
  HangoutsApiError,
  loginWithKeychain,
  loginWithSignFn,
  isKeychainAvailable,
  type Room,
  type AuthSession,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type ChallengeResponse,
  type ParticipantRole,
  type HandRaiseEvent,
  type HangoutsApiClientOptions,
  type HangoutsEvent,
  type CreateEventInput,
  type UpdateEventInput,
  type EventStatus,
  type EventVisibility,
  type UserPresence,
  type StartEventResponse,
} from '@snapie/hangouts-core';

// Provider
export { HangoutsProvider, type HangoutsProviderProps } from './context/HangoutsProvider.js';
export { useHangoutsContext, type HangoutsContextValue } from './context/HangoutsContext.js';

// Hooks
export { useHangoutsAuth } from './hooks/useHangoutsAuth.js';
export { useRoomList } from './hooks/useRoomList.js';
export { useHangoutsRoom } from './hooks/useHangoutsRoom.js';
export { getParticipantRole } from './hooks/useParticipantRole.js';
export { useHandRaise } from './hooks/useHandRaise.js';
export { useHandRaiseChime } from './hooks/useHandRaiseChime.js';
export { useHostControls } from './hooks/useHostControls.js';
export { useHiveAvatar } from './hooks/useHiveAvatar.js';
export { useBoosts, useBoostStore, BoostStoreProvider } from './hooks/useBoosts.js';

// Components — Room
export { HangoutsRoom, type HangoutsRoomProps } from './components/room/HangoutsRoom.js';
export { SpeakerStage, type SpeakerStageProps } from './components/room/SpeakerStage.js';
export { AudienceSection, type AudienceSectionProps } from './components/room/AudienceSection.js';
export { RoomControls, type RoomControlsProps } from './components/room/RoomControls.js';
export { ParticipantTile, type ParticipantTileProps } from './components/room/ParticipantTile.js';
export { HostControlsPanel, type HostControlsPanelProps } from './components/room/HostControlsPanel.js';
export { RoomHeader, type RoomHeaderProps } from './components/room/RoomHeader.js';
export { ChatPanel } from './components/room/ChatPanel.js';
export { BoostOverlay } from './components/room/BoostOverlay.js';
export { SendBoostDialog } from './components/room/SendBoostDialog.js';
export { BoostHistoryPanel } from './components/room/BoostHistoryPanel.js';
export { BoostSettingsPanel } from './components/room/BoostSettingsPanel.js';
export { RecordingControls, RecordingIndicator } from './components/room/RecordingControls.js';
export { StreamingPanel, StopStreamingPanel, type StreamingPanelProps, type StopStreamingPanelProps } from './components/room/StreamingPanel.js';
export { HangoutsErrorBoundary } from './components/room/HangoutsErrorBoundary.js';
export { ScreenShareView } from './components/room/ScreenShareView.js';

// Hooks — Chat
export { useChat, type ChatMessage } from './hooks/useChat.js';

// Hooks — Recording
export { useRecording } from './hooks/useRecording.js';

// Hooks — Streaming
export { useStreaming } from './hooks/useStreaming.js';

// Hooks — Events & Presence
export { useEventList } from './hooks/useEventList.js';
export { useUserPresence } from './hooks/useUserPresence.js';

// Hooks — Push-to-Talk
export { usePushToTalk, type UsePushToTalkOptions, type UsePushToTalkResult } from './hooks/usePushToTalk.js';

// Hooks — Games
export { useWordGuess, type UseWordGuessOptions, type UseWordGuessResult, type WordGuessEvent } from './hooks/useWordGuess.js';
export { useChess, type UseChessOptions, type UseChessResult, type ChessGameStatus } from './hooks/useChess.js';
export { useFastDraw, type UseFastDrawOptions, type UseFastDrawResult, type FastDrawConfig, type FastDrawPhase, type Stroke } from './hooks/useFastDraw.js';

// Components — Games
export { GamePanel, type GamePanelProps } from './components/room/GamePanel.js';

// Components — Lobby
export { RoomLobby, type RoomLobbyProps } from './components/lobby/RoomLobby.js';
export { RoomCard, type RoomCardProps } from './components/lobby/RoomCard.js';
export { CreateRoomDialog, type CreateRoomDialogProps } from './components/lobby/CreateRoomDialog.js';
export { GuestNameModal, type GuestNameModalProps } from './components/lobby/GuestNameModal.js';
export { ObsPanel, type ObsPanelProps } from './components/room/ObsPanel.js';

// Styles — import this in your app: import '@hive-hangouts/react/styles'
