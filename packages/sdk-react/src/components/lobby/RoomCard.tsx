import type { Room } from '@snapie/hangouts-core';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';

type RoomWithMetadata = Room & {
  language?: string;
};

export interface RoomCardProps {
  room: RoomWithMetadata;
  onJoin: (roomName: string) => void;
}

export function RoomCard({ room, onJoin }: RoomCardProps) {
  const hostAvatar = useHiveAvatar(room.host, 'small');

  return (
    <div className="hh-room-card" onClick={() => onJoin(room.name)}>
      {room.backgroundImage && (
        <img
          className="hh-room-card__bg"
          src={room.backgroundImage}
          alt=""
        />
      )}
      <div className="hh-room-card__content">
        <img className="hh-room-card__avatar" src={hostAvatar} alt={room.host} />
        <div className="hh-room-card__info">
          <h3 className="hh-room-card__title">{room.title}</h3>
          <div className="hh-room-card__meta">Hosted by {room.host}</div>
          {room.language && (
            <div className="hh-room-card__meta">Language: {room.language}</div>
          )}
        </div>
        <div className="hh-room-card__count">
          {room.numParticipants ?? 0} listening
        </div>
      </div>
    </div>
  );
}
