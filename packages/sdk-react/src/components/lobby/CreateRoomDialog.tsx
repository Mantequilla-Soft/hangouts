import { useState } from 'react';
import type { Room } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';

export interface CreateRoomDialogProps {
  onCreated: (room: Room) => void;
  onCancel?: () => void;
}

export function CreateRoomDialog({ onCreated, onCancel }: CreateRoomDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const { create, isLoading } = useHangoutsRoom();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const room = await create(title.trim(), description.trim() || undefined);
    if (room) onCreated(room);
  };

  return (
    <form className="hh-create-dialog" onSubmit={handleSubmit}>
      <div className="hh-create-dialog__row">
        <input
          className="hh-create-dialog__input"
          type="text"
          placeholder="Room title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={64}
          autoFocus
        />
      </div>
      <div className="hh-create-dialog__row">
        <input
          className="hh-create-dialog__input"
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={256}
        />
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="hh-btn hh-btn--primary" type="submit" disabled={!title.trim() || isLoading}>
          {isLoading ? 'Creating...' : 'Start room'}
        </button>
        {onCancel && (
          <button className="hh-btn hh-btn--secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
