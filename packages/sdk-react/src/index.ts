// Re-export core types and utilities
export {
  HangoutsApiClient,
  HangoutsApiError,
  loginWithKeychain,
  loginWithSignFn,
  isKeychainAvailable,
  type Room,
  type RoomMode,
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
  type PremiumStatus,
  type PremiumSubscriber,
  type StartProTrialResponse,
  type GameResultPayload,
  type ChessGameResult,
  type FastDrawGameResult,
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
export { useWhipIngress, type UseWhipIngress } from './hooks/useWhipIngress.js';
export { isChromium, isInAppBrowser, canBroadcast } from './lib/browser.js';
export { CollabRequest, type CollabRequestProps } from './components/room/CollabRequest.js';
export { BoostHistoryPanel } from './components/room/BoostHistoryPanel.js';
export { BoostSettingsPanel } from './components/room/BoostSettingsPanel.js';
export { RecordingControls, RecordingIndicator } from './components/room/RecordingControls.js';
export { StreamingPanel, StopStreamingPanel, type StreamingPanelProps, type StopStreamingPanelProps } from './components/room/StreamingPanel.js';
export { HangoutsErrorBoundary } from './components/room/HangoutsErrorBoundary.js';
export { ScreenShareView } from './components/room/ScreenShareView.js';
export { StandaloneStudio, type StandaloneStudioProps, type StudioSceneId, type PipCorner , type StreamVodResult } from './components/room/StandaloneStudio.js';
export { StandaloneViewer, type StandaloneViewerProps } from './components/room/StandaloneViewer.js';
export { StandaloneObsOverlay, type StandaloneObsOverlayProps } from './components/room/StandaloneObsOverlay.js';
export {
  StandaloneWatch, type StandaloneWatchProps,
  StreamVideo, type StreamVideoProps,
  StreamViewerCount, type StreamViewerCountProps,
  StreamQualityControl,
  useStreamContext, useStreamLive,
} from './components/room/StandaloneWatch.js';

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
export { CreateRoomDialog, type CreateRoomDialogProps, type AnnounceType } from './components/lobby/CreateRoomDialog.js';
export { GuestNameModal, type GuestNameModalProps } from './components/lobby/GuestNameModal.js';
export { ObsPanel, type ObsPanelProps } from './components/room/ObsPanel.js';

// Pro (premium): plans / checkout, upsell, subscriber ticker.
// ProPlans also has a default export so it can be code-split with React.lazy —
// that's what keeps the VSC + GraphQL code out of an integrator's boot chunk.
export { ProPlans, type ProPlansProps } from './components/pro/ProPlans.js';
export { ProUpsellDialog, DEFAULT_STREAM_PERKS, type ProUpsellDialogProps, type ProPerk } from './components/pro/ProUpsellDialog.js';
export { SubscriberTicker, type SubscriberTickerProps } from './components/pro/SubscriberTicker.js';
export { usePremiumStatus, invalidatePremiumStatus, type UsePremiumStatusResult } from './hooks/usePremiumStatus.js';
export { useProTrial, type UseProTrialResult } from './hooks/useProTrial.js';
export { useVscSubs } from './hooks/useVscSubs.js';
export {
  VscSubsClient,
  resolveProConfig,
  buildTransferIntent,
  parseContractResponse,
  DEFAULT_SUBS_CONTRACT_ID,
  DEFAULT_SUB_OFFER_ID,
  DEFAULT_ONETIME_OFFER_ID,
  type ProConfig,
  type ResolvedProConfig,
  type HiveKeyType,
  type HiveOperation,
  type SignResult,
  type TransferIntent,
  type PollResult,
} from './lib/vscContract.js';

// Styles — import this in your app: import '@hive-hangouts/react/styles'
export { useIsMobile, MOBILE_QUERY } from './hooks/useIsMobile.js';
