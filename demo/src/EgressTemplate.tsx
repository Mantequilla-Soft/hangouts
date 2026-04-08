import { useEffect, useState } from 'react';
import { LiveKitRoom, RoomAudioRenderer, useRoomInfo } from '@livekit/components-react';

const DEFAULT_BG = 'https://hotipfs-3speak-1.b-cdn.net/ipfs/QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn';

function BackgroundView() {
  const { metadata } = useRoomInfo();
  const [bgUrl, setBgUrl] = useState(DEFAULT_BG);

  useEffect(() => {
    if (!metadata) return;
    try {
      const meta = JSON.parse(metadata);
      if (meta.streamBg) setBgUrl(meta.streamBg);
    } catch { /* ignore */ }
  }, [metadata]);

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundImage: `url(${bgUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }} />
  );
}

export function EgressTemplate() {
  const params = new URLSearchParams(window.location.search);
  const serverUrl = params.get('url') ?? '';
  const token = params.get('token') ?? '';

  if (!serverUrl || !token) {
    return (
      <div style={{ background: '#000', width: '100vw', height: '100vh' }}>
        <img src={DEFAULT_BG} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
      </div>
    );
  }

  return (
    <LiveKitRoom serverUrl={serverUrl} token={token} connect audio video={false}>
      <RoomAudioRenderer />
      <BackgroundView />
    </LiveKitRoom>
  );
}
