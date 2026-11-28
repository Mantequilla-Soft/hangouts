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
// Boost goals, tiers, alerts, preset amounts and top supporters.
export { useRoomBoost, useGoalCelebration, type RoomBoostState } from './hooks/useRoomBoost.js';
export { useBoostAlerts, type BoostAlertOptions } from './hooks/useBoostAlerts.js';
// Live battles (H16): the meter, the studio panel, the hooks and the layout layer.
export { useRoomBattle, useStudioBattle, type RoomBattleState, type StudioBattle, type BattleCandidate } from './hooks/useBattle.js';
export { useBattleLink, type BattleLinkState, type BattleLinkGrant } from './hooks/useBattleLink.js';
export {
  readBattle, battlePhase, battleOnAir, battleShare, battleResultText, battleLabels, DEFAULT_BATTLE_LABELS,
  BATTLE_DURATIONS, type Battle, type BattlePhase, type BattleSide, type BattleLabels,
} from './lib/battle.js';
export { battleTiles, drawBattleLayer, type BattleRect, type BattleTiles, type BattleLayerOptions } from './lib/battleLayout.js';
export {
  BOOST_TIERS,
  DEFAULT_BOOST_PRESETS,
  DEFAULT_GOAL_POSITION,
  GOAL_POSITIONS,
  boostTier,
  boostDisplayMs,
  boostPresets,
  alertSettings as boostAlertSettings,
  formatHbd,
  type BoostGoal,
  type BoostRoomConfig,
  type BoostStats,
  type BoostSupporter,
  type BoostTier,
  type BoostAlertSettings,
  type GoalProgress,
  type GoalPosition,
} from './lib/boostGoals.js';
export { DEFAULT_BOOST_LABELS, type BoostLabels } from './lib/boostLabels.js';
export { playBoostChime } from './lib/boostChime.js';
// Stream time caps (free / Pro), so an integrator shows the same numbers the studio enforces.
export {
  resolveStreamCap, capLabel as streamCapLabel, FREE_STREAM_CAP_MS, FREE_STREAM_CAP_LABEL, PRO_STREAM_CAP_MS, PRO_STREAM_CAP_LABEL,
  type StreamCap,
} from './lib/streamLimits.js';

// Points shop in the live room: viewer actions, host tools, chat cosmetics and
// stickers, read-aloud, extra stream time.
export {
  PointsShopActions, PointsShopDialog, PointsShopMenu, SHOP_ACTIONS, availableShopActions,
  HighlightMessageDialog, ReadAloudDialog, SuggestPollDialog, RedeemRewardDialog, BountyDialog, UnlockStickersDialog,
  type ShopAction, type PointsShopActionsProps, type PointsShopDialogProps, type PointsShopMenuProps,
} from './components/room/PointsShop.js';
export {
  PollSuggestionsPanel, PollSuggestionsView, ChannelRewardsPanel, RewardQueueView, RewardsEditor, rewardsProblem,
  BountiesPanel, BountiesView, ReadAloudAlerts, BuyStreamTimeButton,
  type PollSuggestionsViewProps, type RewardQueueViewProps, type RewardsEditorProps, type BountiesViewProps, type BuyStreamTimeButtonProps,
} from './components/room/ShopHostPanels.js';
export {
  useShopCatalog, useCosmetics, useChannelSupporters, usePointsBalance, useStreamExtra, usePinnedChat,
  primeCosmetics, primeSupporters, primeShopCatalog, invalidateCosmetics,
} from './hooks/useShopData.js';
export { usePollSuggestions, useRewardQueue, useChannelRewards, useBounties, useServerTopic } from './hooks/useShopHost.js';
export { useReadAloud, type ReadAloudOptions } from './hooks/useReadAloud.js';
export {
  shopApi, buyShopItem, parseShopCatalog, shopQuote, parseCosmetics, chatLook, isHiveAccount,
  stickerIdOf, stickerText, ownsStickers, activePinnedChat, planReadAloud, readAloudOn,
  DEFAULT_STICKERS, DEFAULT_SHOP_PRICES, EMPTY_COSMETICS,
  COSMETIC_LOOKS, NAME_COLORS, BADGE_EMOJIS, FRAME_CLASSES, THEME_CLASSES,
  REWARDS_MAX, REWARD_COST_MIN, REWARD_COST_MAX,
  type ShopCatalog, type ShopItemQuote, type ShopOrder, type ShopBuyOutcome, type BuyShopItemOptions,
  type CosmeticKind, type CosmeticLook, type CosmeticsView, type PinnedChat,
  type PollSuggestion, type ChannelReward, type Redemption, type Bounty, type ReadAloudEvent,
  type PollSuggestionPacket, type RewardsPacket, type BountyPacket, type LiveShopItem,
} from './lib/pointsShop.js';
export { DEFAULT_SHOP_LABELS, shopLabels, type ShopLabels } from './lib/shopLabels.js';
// The spend helper behind points boosts and the shop (428 sign, 202 pending).
export { spendPoints, walletSigner, type PointsSpendOutcome } from './lib/pointsSpend.js';

// Components — Room
export { HangoutsRoom, type HangoutsRoomProps } from './components/room/HangoutsRoom.js';
export { SpeakerStage, type SpeakerStageProps } from './components/room/SpeakerStage.js';
export { AudienceSection, type AudienceSectionProps } from './components/room/AudienceSection.js';
export { RoomControls, type RoomControlsProps } from './components/room/RoomControls.js';
export { ParticipantTile, type ParticipantTileProps } from './components/room/ParticipantTile.js';
export { HostControlsPanel, type HostControlsPanelProps } from './components/room/HostControlsPanel.js';
export { RoomHeader, type RoomHeaderProps } from './components/room/RoomHeader.js';
export { ChatPanel, ChatBubble, ChatSystemLine, PinnedChatBar, type ChatPanelProps, type ChatBubbleProps } from './components/room/ChatPanel.js';
// Record an audio room as a podcast episode (H23), and the helpers behind the
// highlight clips (H13), rewind (H14) and podcast endpoints.
export { PodcastRecordControls, type PodcastRecordControlsProps, type PodcastHandoff } from './components/room/PodcastRecordControls.js';
export {
  podcastApi, waitForEpisode, chapterTitle,
  type PodcastEpisode, type PodcastChapter, type PodcastChapterKind, type PodcastStatus,
} from './lib/hangoutsHttp.js';
export { BoostOverlay } from './components/room/BoostOverlay.js';
export { SendBoostDialog } from './components/room/SendBoostDialog.js';
export {
  StreamBoostGoal,
  BoostTopSupporters,
  BoostAlerts,
  type StreamBoostGoalProps,
  type BoostTopSupportersProps,
  type BoostAlertsProps,
} from './components/room/StreamBoostGoal.js';
export { StreamBattleBar, type StreamBattleBarProps } from './components/room/StreamBattleBar.js';
export { BattlePanel, BattleInviteCard, type BattlePanelProps } from './components/room/BattlePanel.js';
export { useWhipIngress, type UseWhipIngress } from './hooks/useWhipIngress.js';
export { isChromium, isInAppBrowser, canBroadcast } from './lib/browser.js';
export { CollabRequest, type CollabRequestProps } from './components/room/CollabRequest.js';
export { BoostHistoryPanel, BoostHistoryList } from './components/room/BoostHistoryPanel.js';
export { BoostSettingsPanel, type BoostSettingsUpdate } from './components/room/BoostSettingsPanel.js';
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
  useStreamContext, useStreamLive, useStreamFormats,
} from './components/room/StandaloneWatch.js';
export { HlsStreamVideo, type HlsStreamVideoProps } from './components/room/HlsStreamVideo.js';
export {
  PhoneScreenSourceDialog, DEFAULT_PHONE_SCREEN_LABELS, PHONE_SCREEN_LABEL_KEYS, detectComputerOs, pictureSteps, soundSteps,
  type PhoneScreenSourceDialogProps, type PhoneScreenSourceLabels, type ComputerOs, type PhoneOs, type GuideStep,
} from './components/room/PhoneScreenSourceDialog.js';
export type { Delivery, JoinOptions } from './lib/hlsDelivery.js';

// Live captions (H11): host opt-in speech-to-text over the data channel, viewer overlay, on-device translation.
export { useStudioCaptions, type StudioCaptions, type StudioCaptionsOptions } from './hooks/useStudioCaptions.js';
export { useLiveCaptions, type LiveCaptionsState } from './hooks/useLiveCaptions.js';
export { LiveCaptionsToggle, DEFAULT_STUDIO_CAPTION_LABELS, type StudioCaptionLabels } from './components/room/LiveCaptionsToggle.js';
export { StreamCaptions, DEFAULT_STREAM_CAPTION_LABELS, type StreamCaptionsProps, type StreamCaptionLabels } from './components/room/StreamCaptions.js';
export {
  CAPTIONS_TOPIC,
  tidyCaption,
  baseLang as captionBaseLang,
  type CaptionSource,
  type CaptionLanguage,
  type CaptionCue,
  type CaptionMessage,
} from './lib/liveCaptions.js';
export { translationMode as captionTranslationMode, languageName as captionLanguageName, type TranslateMode } from './lib/captionTranslate.js';
export type { StudioCaptionStatus } from './lib/captionPublisher.js';

// Hooks — Chat
export { useChat, type ChatMessage } from './hooks/useChat.js';
export { mergeChatLines, parseBacklog, parseSystemInfo, type BacklogLine, type ChatSystemInfo, type ChatSystemKind } from './lib/chatBacklog.js';
// Who may send what on the data channel, for integrators reading topics themselves.
export {
  DATA_TOPIC_TRUST, isServerSent, isSentBy, hostFromMetadata, decodeData,
  readChatPacket, readBoostPacket, readPollPacket, readRaidPacket, readGamePacket,
  readCaptionPacket, readViewStatePacket, readVolumePacket, readHandRaisePacket, readDrawPacket,
  readReadAloudPacket, readPollSuggestionPacket, readRewardsPacket, readBountyPacket,
  type DataSender, type TopicTrust, type ChatPacket, type RaidPacketType,
  type ViewStatePacket, type VolumePacket, type DrawPacket,
} from './lib/dataTrust.js';

// Live interaction: polls and predictions, raids, and their viewer text.
export { usePolls, type CreatePollInput } from './hooks/usePolls.js';
export { useRaid, parseRaid, type RaidTargetInfo, type ViewerRaid } from './hooks/useRaid.js';
export { StreamPollCard, PollCardView, PollHostPanel, type StreamPollCardProps, type PollCardViewProps } from './components/room/StreamPolls.js';
export { RaidBanner, RaidBannerView, type RaidBannerProps, type RaidBannerViewProps } from './components/room/RaidBanner.js';
export { RaidHostPanel } from './components/room/RaidHostPanel.js';
export { StudioLivePanel, type LiveSubtab } from './components/room/StudioLivePanel.js';
export { StudioSubtabs, type StudioSubtab } from './components/room/StudioSubtabs.js';
export { DEFAULT_LIVE_LABELS, liveLabels, fillLabel, clockLabel, type LiveLabels } from './lib/liveLabels.js';
export {
  parsePoll, isFinished as isPollFinished, optionShare, leaders as pollLeaders, payoutFor,
  type PollView, type PollOptionView, type PollKind, type PollStatus, type PollStake,
} from './lib/polls.js';

// Hooks — Recording
export { useRecording } from './hooks/useRecording.js';

// Hooks — Streaming
export { useStreaming, type StreamPlatform as RestreamPlatform } from './hooks/useStreaming.js';

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
export { CreateRoomDialog, type CreateRoomDialogProps, type AnnounceType, type CreateRoomDraft, type StepLabels, type CreateRoomLabels, DEFAULT_CREATE_ROOM_LABELS } from './components/lobby/CreateRoomDialog.js';
export { GuestNameModal, type GuestNameModalProps } from './components/lobby/GuestNameModal.js';
export { ObsPanel, type ObsPanelProps } from './components/room/ObsPanel.js';

// Pro (premium): plans / checkout, upsell, subscriber ticker.
// ProPlans also has a default export so it can be code-split with React.lazy —
// that's what keeps the VSC + GraphQL code out of an integrator's boot chunk.
export { ProPlans, type ProPlansProps } from './components/pro/ProPlans.js';
export { ProUpsellDialog, DEFAULT_STREAM_PERKS, type ProUpsellDialogProps, type ProPerk, type ProUpsellLabels } from './components/pro/ProUpsellDialog.js';
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
export { DEFAULT_PRO_SALE, saleOpen, saleNextChange, percentOff, type ProSale } from './lib/proSale.js';

// Styles — import this in your app: import '@hive-hangouts/react/styles'
export { useIsMobile, MOBILE_QUERY, PHONE_STUDIO_QUERY } from './hooks/useIsMobile.js';
export { useKeyboardInset } from './hooks/useKeyboardInset.js';

// The create form's remembered setup and the stream recording preferences, so
// an integrator can pre-fill the form (e.g. from a saved stream template) in
// the same format the form reads, instead of copying storage keys.
export { readPostDraft, writePostDraft, type PostDraft, type DraftMode } from './lib/postDraft.js';
export { AUTO_VOD_KEY, AUTO_DL_KEY, ALLOW_CLIPS_KEY, readPref, writePref } from './utils/streamRecordingPrefs.js';

// Studio overlays (H17), the phone version (H19) and stream health (H20).
export {
  OverlayLayerList, FadeTransition, createTextOverlayLayers, cleanOverlayConfig, DEFAULT_OVERLAY_CONFIG,
  type OverlayLayer, type FrameInfo, type OverlayConfig, type OverlayTemplate, type OutputShape,
} from './lib/studioOverlays.js';
export { BUILTIN_TRACKS, type BuiltinTrackId } from './lib/brbMusic.js';
export {
  STUDIO_PROGRAM_TRACK, STUDIO_VERTICAL_TRACK, readVerticalMeta, objectPositionFor, prefersVertical,
  type VerticalMeta, type VerticalMode, type VerticalFollow,
} from './lib/verticalCrop.js';
export { useStreamHealth, type StreamHealthState } from './hooks/useStreamHealth.js';
export { describeViewerQuality, type StreamHealth } from './lib/streamHealth.js';
