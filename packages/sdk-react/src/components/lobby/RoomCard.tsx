import type { Room } from '@hive-hangouts/core';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';

export interface RoomCardProps {
  room: Room;
  onJoin: (roomName: string) => void;
}

export function RoomCard({ room, onJoin }: RoomCardProps) {
  const hostAvatar = useHiveAvatar(room.host, 'small');

  return (
    <div className="hh-room-card" onClick={() => onJoin(room.name)}>
      <img className="hh-room-card__avatar" src={hostAvatar} alt={room.host} />
      <div className="hh-room-card__info">
        <h3 className="hh-room-card__title">{room.title}</h3>
        <div className="hh-room-card__meta">Hosted by {room.host}</div>
      </div>
      <div className="hh-room-card__count">
        {room.numParticipants ?? 0} listening
      </div>
    </div>
  );
}
