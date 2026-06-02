/**
 * LoadingSkeleton - Skeleton loading placeholders with shimmer animation.
 * Provides visual feedback during data loading states.
 */

import React from 'react';

type SkeletonVariant = 'text' | 'card' | 'avatar' | 'button';

interface LoadingSkeletonProps {
  variant?: SkeletonVariant;
  width?: string;
  height?: string;
  count?: number;
  ariaLabel?: string;
}

// Shimmer animation keyframes (injected once via style tag)
const shimmerAnimation = `
  @keyframes shimmer {
    0% {
      background-position: -200% 0;
    }
    100% {
      background-position: 200% 0;
    }
  }
`;

// Check if style has already been injected
let styleInjected = false;
const injectShimmerStyle = (): void => {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = shimmerAnimation;
  document.head.appendChild(style);
  styleInjected = true;
};

const skeletonBaseStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-secondary)',
  backgroundImage: 'linear-gradient(90deg, var(--color-secondary) 0%, var(--color-bubble-assistant) 50%, var(--color-secondary) 100%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
  borderRadius: '4px',
};

interface SkeletonLineProps {
  width?: string;
  height?: string;
}

const SkeletonLine = ({ width = '100%', height = '14px' }: SkeletonLineProps): React.ReactElement => (
  <div
    style={{
      ...skeletonBaseStyle,
      width,
      height,
    }}
  />
);

interface SkeletonCardProps {
  width?: string;
  height?: string;
}

const SkeletonCard = ({ width = '100%', height = '120px' }: SkeletonCardProps): React.ReactElement => (
  <div
    style={{
      ...skeletonBaseStyle,
      width,
      height,
      borderRadius: '8px',
    }}
  />
);

interface SkeletonAvatarProps {
  size?: string;
}

const SkeletonAvatar = ({ size = '40px' }: SkeletonAvatarProps): React.ReactElement => (
  <div
    style={{
      ...skeletonBaseStyle,
      width: size,
      height: size,
      borderRadius: '50%',
      flexShrink: 0,
    }}
  />
);

interface SkeletonButtonProps {
  width?: string;
}

const SkeletonButton = ({ width = '100px' }: SkeletonButtonProps): React.ReactElement => (
  <div
    style={{
      ...skeletonBaseStyle,
      width,
      height: '36px',
      borderRadius: '6px',
    }}
  />
);

const renderVariant = (variant: SkeletonVariant, width?: string, height?: string): React.ReactElement => {
  switch (variant) {
    case 'card':
      return <SkeletonCard width={width} height={height} />;
    case 'avatar':
      return <SkeletonAvatar size={width || '40px'} />;
    case 'button':
      return <SkeletonButton width={width} />;
    case 'text':
    default:
      return <SkeletonLine width={width} height={height || '14px'} />;
  }
};

/**
 * LoadingSkeleton component with variants for different content types.
 * Renders animated placeholder shapes during loading states.
 *
 * @example
 * // Text skeleton (default)
 * <LoadingSkeleton variant="text" />
 *
 * // Card skeleton
 * <LoadingSkeleton variant="card" />
 *
 * // Avatar skeleton
 * <LoadingSkeleton variant="avatar" width="48px" />
 *
 * // Multiple text lines
 * <LoadingSkeleton variant="text" count={3} />
 */
export function LoadingSkeleton({
  variant = 'text',
  width,
  height,
  count = 1,
  ariaLabel = 'Loading',
}: LoadingSkeletonProps): React.ReactElement {
  React.useEffect(() => {
    injectShimmerStyle();
  }, []);

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing-md)',
    width: '100%',
  };

  if (count === 1) {
    return (
      <div
        style={containerStyle}
        role="status"
        aria-busy="true"
        aria-label={ariaLabel}
      >
        {renderVariant(variant, width, height)}
      </div>
    );
  }

  return (
    <div
      style={containerStyle}
      role="status"
      aria-busy="true"
      aria-label={ariaLabel}
    >
      {Array.from({ length: count }, (_, index) => (
        <React.Fragment key={index}>
          {renderVariant(variant, width, height)}
        </React.Fragment>
      ))}
    </div>
  );
}

export default LoadingSkeleton;
