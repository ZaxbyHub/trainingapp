import { useState, useRef, useEffect } from 'react';
import { formatRelativeTime } from '../utils/relativeTime';
import { Button, Icon } from '../ui';
import { cx } from '../ui/cx';

interface SidebarConversationItemProps {
  id: string;
  title: string;
  timestamp: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
}

/**
 * One conversation row. Styling lives in layouts/shell.css (Lumen tokens only):
 * hover is --bg-hover, selected is --bg-selected + weight 600 (never color
 * alone), focus is the outline ring, and the options button is revealed on
 * hover / keyboard focus (always shown on touch devices).
 */
export function SidebarConversationItem({
  id,
  title,
  timestamp,
  isSelected,
  onSelect,
  onRename,
  onDelete,
}: SidebarConversationItemProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editTitle, setEditTitle] = useState(title);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isRenaming) {
      setEditTitle(title);
    }
  }, [title, isRenaming]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        kebabRef.current &&
        !kebabRef.current.contains(target)
      ) {
        setIsMenuOpen(false);
        setIsDeleteConfirmOpen(false);
      }
    };

    if (isMenuOpen || isDeleteConfirmOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isMenuOpen, isDeleteConfirmOpen]);

  const handleKebabClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setIsMenuOpen((prev) => !prev);
    setIsDeleteConfirmOpen(false);
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    setIsDeleteConfirmOpen(false);
    setEditTitle(title);
    setIsRenaming(true);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    setIsDeleteConfirmOpen(true);
  };

  const handleConfirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(id);
    setIsDeleteConfirmOpen(false);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDeleteConfirmOpen(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const trimmed = editTitle.trim();
      onRename(id, trimmed || title);
      setIsRenaming(false);
    } else if (e.key === 'Escape') {
      // Consumed here: an enclosing drawer must not also close.
      e.stopPropagation();
      setIsRenaming(false);
    }
  };

  const handleRenameBlur = () => {
    const trimmed = editTitle.trim();
    if (trimmed !== title && trimmed !== '') {
      onRename(id, trimmed);
    }
    setIsRenaming(false);
  };

  const handleRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isRenaming && !isMenuOpen && !isDeleteConfirmOpen) {
      e.preventDefault();
      onSelect(id);
    }
    if (e.key === 'Escape' && (isMenuOpen || isDeleteConfirmOpen)) {
      // Consumed here: Escape closes this menu only, not an enclosing drawer.
      e.stopPropagation();
      setIsMenuOpen(false);
      setIsDeleteConfirmOpen(false);
    }
  };

  const displayTitle = title || 'Untitled conversation';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!isRenaming && !isMenuOpen && !isDeleteConfirmOpen) {
          onSelect(id);
        }
      }}
      onKeyDown={handleRootKeyDown}
      aria-current={isSelected ? 'page' : undefined}
      className={cx('app-conv', 'ui-focusable', isSelected && 'ui-selected', isRenaming && 'app-conv--renaming')}
    >
      <div className="app-conv__row">
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            aria-label="Edit conversation title"
            className="app-conv__input"
          />
        ) : (
          <span className="app-conv__title" title={displayTitle}>
            {displayTitle}
          </span>
        )}
        {!isRenaming && (
          <button
            ref={kebabRef}
            type="button"
            onClick={handleKebabClick}
            aria-label="Conversation options"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen || isDeleteConfirmOpen}
            className="app-conv__kebab ui-focusable"
          >
            <Icon name="ellipsis" size={18} />
          </button>
        )}
      </div>
      <span className="app-conv__time">{formatRelativeTime(timestamp)}</span>
      {(isMenuOpen || isDeleteConfirmOpen) && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Conversation actions"
          className="app-menu"
          onClick={(e) => e.stopPropagation()}
        >
          {isDeleteConfirmOpen ? (
            <div className="app-menu__confirm" role="alert">
              <div className="app-menu__confirm-text">Delete this conversation?</div>
              <div className="app-menu__confirm-actions">
                <Button role="menuitem" size="sm" variant="danger" onClick={handleConfirmDelete}>
                  Confirm
                </Button>
                <Button role="menuitem" size="sm" variant="secondary" onClick={handleCancelDelete}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={handleRenameClick} className="app-menu__item ui-focusable">
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleDeleteClick}
                className="app-menu__item app-menu__item--danger ui-focusable"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
