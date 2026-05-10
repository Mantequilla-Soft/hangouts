import { useState, useEffect, useRef } from 'react';
import type { Room, RoomVisibility } from '@snapie/hangouts-core';
import { useHangoutsRoom } from '../../hooks/useHangoutsRoom.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';

export interface CreateRoomDialogProps {
  /** Fired after the room is created. The second argument carries
   *  UI-only options the integrator can act on — e.g. whether to post
   *  an announcement on Hive. The host stays responsible for the
   *  announcement; the SDK only collects the user's preference. */
  onCreated: (room: Room, options: { notifyOnHive: boolean }) => void;
  onCancel?: () => void;
}

async function uploadTo3Speak(file: File, apiKey: string): Promise<string> {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch('https://images.3speak.tv/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const data = await res.json() as { success: boolean; url: string };
  if (!data.success || !data.url) throw new Error('Image upload failed');
  return data.url;
}

function getBgStorageKey(username: string) {
  return `hh_bg_image_${username}`;
}

export function CreateRoomDialog({ onCreated, onCancel }: CreateRoomDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [backgroundImageUrl, setBackgroundImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [notifyOnHive, setNotifyOnHive] = useState(true);
  const [visibility, setVisibility] = useState<RoomVisibility>('public');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { create, isLoading } = useHangoutsRoom();
  const { username, imageServerApiKey } = useHangoutsContext();

  useEffect(() => {
    if (!imageServerApiKey || !username) {
      setBackgroundImageUrl('');
      return;
    }
    const stored = localStorage.getItem(getBgStorageKey(username));
    setBackgroundImageUrl(stored ?? '');
  }, [username, imageServerApiKey]);

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !imageServerApiKey) return;
    setUploadError('');
    setUploading(true);
    try {
      const url = await uploadTo3Speak(file, imageServerApiKey);
      setBackgroundImageUrl(url);
      if (username) localStorage.setItem(getBgStorageKey(username), url);
    } catch {
      setUploadError('Upload failed — please try again');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearBackground = () => {
    setBackgroundImageUrl('');
    if (username) localStorage.removeItem(getBgStorageKey(username));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const bg = imageServerApiKey ? (backgroundImageUrl || undefined) : undefined;
    const room = await create(title.trim(), description.trim() || undefined, bg, visibility);
    // Unlisted rooms shouldn't trigger a Hive announcement — defeats the
    // purpose. Force the integrator's notify flag off for that tier.
    const shouldNotify = visibility === 'unlisted' ? false : notifyOnHive;
    if (room) onCreated(room, { notifyOnHive: shouldNotify });
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

      {imageServerApiKey && (
        <div className="hh-create-dialog__row">
          <div className="hh-bg-picker">
            {backgroundImageUrl ? (
              <div className="hh-bg-picker__preview-wrap">
                <div
                  className="hh-bg-picker__preview"
                  style={{ backgroundImage: `url(${backgroundImageUrl})` }}
                >
                  <span className="hh-bg-picker__preview-label">Background preview</span>
                </div>
                <div className="hh-bg-picker__actions">
                  <button
                    type="button"
                    className="hh-btn hh-btn--secondary hh-btn--small"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="hh-btn hh-btn--ghost hh-btn--small"
                    onClick={clearBackground}
                  >
                    Remove
                  </button>
                  <span className="hh-bg-picker__hint hh-bg-picker__hint--inline">
                    16:9 recommended: background renders at this aspect ratio
                  </span>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="hh-bg-picker__upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? 'Uploading...' : '+ Add background image'}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleImageChange}
            />
            {!backgroundImageUrl && (
              <p className="hh-bg-picker__hint">
                16:9 recommended: background renders at this aspect ratio
              </p>
            )}
            {uploadError && <p className="hh-bg-picker__error">{uploadError}</p>}
          </div>
        </div>
      )}

      <div className="hh-create-dialog__row">
        <label className="hh-create-dialog__field">
          <span className="hh-create-dialog__field-label">Visibility</span>
          <select
            className="hh-create-dialog__select"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as RoomVisibility)}
          >
            <option value="public">Public — anyone can listen as a guest</option>
            <option value="hive-internal">Hive-internal — Hive sign-in required</option>
            <option value="unlisted">Unlisted — link only, hidden from lobby</option>
          </select>
        </label>
      </div>

      {visibility !== 'unlisted' && (
        <div className="hh-create-dialog__row">
          <label className="hh-create-dialog__check">
            <input
              type="checkbox"
              checked={notifyOnHive}
              onChange={(e) => setNotifyOnHive(e.target.checked)}
            />
            <span>Announce this OpenPod on Hive</span>
          </label>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="hh-btn hh-btn--primary" type="submit" disabled={!title.trim() || isLoading || uploading}>
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
