import { useParticipants } from '@livekit/components-react';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';

export interface RoomHeaderProps {
  title: string;
  host: string;
}

export function RoomHeader({ title, host }: RoomHeaderProps) {
  const participants = useParticipants();
  const hostAvatar = useHiveAvatar(host, 'small');

  return (
    <div className="hh-room__header">
      <div>
        <h2 className="hh-room__title">{title}</h2>
        <div className="hh-room__host">
          <img
            src={hostAvatar}
            alt={host}
            style={{ width: 20, height: 20, borderRadius: '50%', verticalAlign: 'middle', marginRight: 6 }}
          />
          {host}
        </div>
      </div>
      <div className="hh-room__count">
        {participants.length} in room
      </div>
    </div>
  );
}
