import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDeviceMemory,
  getMemoryBudget,
  selectModelTier,
  getMemoryPressureStatus,
  formatMemoryIndicator,
  MemoryBudget,
  MemoryPressureStatus,
} from './memory-aware';

// Mock navigator global
const mockNavigator = {
  deviceMemory: undefined as number | undefined,
  userAgent: '',
};

vi.stubGlobal('navigator', mockNavigator);

describe('memory-aware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNavigator.deviceMemory = undefined;
    mockNavigator.userAgent = '';
  });

  describe('getDeviceMemory', () => {
    test('returns navigator.deviceMemory when available', () => {
      mockNavigator.deviceMemory = 8;
      expect(getDeviceMemory()).toBe(8);
    });

    test('returns 4 as conservative default when deviceMemory is undefined', () => {
      mockNavigator.deviceMemory = undefined;
      expect(getDeviceMemory()).toBe(4);
    });

    test('returns 4 when deviceMemory is 0 or negative', () => {
      mockNavigator.deviceMemory = 0;
      expect(getDeviceMemory()).toBe(4);
    });

    test('returns 4 when deviceMemory is negative', () => {
      mockNavigator.deviceMemory = -2;
      expect(getDeviceMemory()).toBe(4);
    });
  });

  describe('getMemoryBudget', () => {
    test('calculates availableMB correctly for Chrome with 8GB device', () => {
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(8192);
      expect(budget.browserOverheadMB).toBe(2048);
      expect(budget.availableMB).toBe(6144);
    });

    test('calculates availableMB correctly for Firefox with 8GB device', () => {
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(8192);
      expect(budget.browserOverheadMB).toBe(2560);
      expect(budget.availableMB).toBe(5632);
    });

    test('calculates availableMB correctly for Safari with 4GB device', () => {
      mockNavigator.deviceMemory = 4;
      mockNavigator.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(4096);
      expect(budget.browserOverheadMB).toBe(2048);
      expect(budget.availableMB).toBe(2048);
    });

    test('calculates availableMB with no deviceMemory (defaults to 4GB)', () => {
      mockNavigator.deviceMemory = undefined;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();

      expect(budget.totalMB).toBe(4096);
      expect(budget.availableMB).toBe(2048);
    });
  });

  describe('selectModelTier', () => {
    test('HIGH tier (>=8GB): rerankingEnabled=true, maxChunkCount=10000', () => {
      const config = selectModelTier(8192);

      expect(config.embeddingModel).toBe('bge-small-en-v1.5');
      expect(config.embeddingDimension).toBe(384);
      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('HIGH tier with memory above 8GB', () => {
      const config = selectModelTier(12288);

      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('MEDIUM tier (>=4GB, <8GB): rerankingEnabled=false, maxChunkCount=5000', () => {
      const config = selectModelTier(4096);

      expect(config.embeddingModel).toBe('bge-small-en-v1.5');
      expect(config.embeddingDimension).toBe(384);
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(5000);
    });

    test('MEDIUM tier with memory just above 4GB threshold', () => {
      const config = selectModelTier(4097);

      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(5000);
    });

    test('LOW tier (<4GB): rerankingEnabled=false, maxChunkCount=1000', () => {
      const config = selectModelTier(2048);

      expect(config.embeddingModel).toBe('bge-small-en-v1.5');
      expect(config.embeddingDimension).toBe(384);
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });

    test('LOW tier with minimal memory (512MB)', () => {
      const config = selectModelTier(512);

      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });

    test('LOW tier at boundary (just below 4GB)', () => {
      const config = selectModelTier(4095);

      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });
  });

  describe('getMemoryPressureStatus', () => {
    beforeEach(() => {
      // Mock for HIGH tier (Chrome, 8GB device)
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';
    });

    test('returns "normal" when availableMB >= 8192', () => {
      // Chrome 8GB: availableMB = 8192 - 2048 = 6144... wait, that's not >= 8192
      // Let me recalculate: 8GB device = 8192MB total, Chrome overhead 2048, available 6144
      // But HIGH tier check is on memoryMB parameter to selectModelTier, not on getMemoryBudget
      // For getMemoryPressureStatus, it checks availableMB from getMemoryBudget
      // With 8GB device in Chrome: availableMB = 6144, which is < 8192, so it returns 'moderate'
      // But the function says: if (availableMB >= 8192) return 'normal'
      // Let me trace through: getMemoryBudget() returns availableMB = 8192 - 2048 = 6144 for 8GB Chrome
      // 6144 >= 8192 is FALSE, so check next: 6144 >= 4096 is TRUE, so return 'moderate'
      // So for getMemoryPressureStatus to return 'normal', we need availableMB >= 8192
      // That means totalMB - overhead >= 8192
      // For Chrome: overhead = 2048, so totalMB >= 10240 (10GB)
      // For Firefox: overhead = 2560, so totalMB >= 10752 (10.5GB)

      mockNavigator.deviceMemory = 16; // 16GB device
      mockNavigator.userAgent = 'Chrome/120.0.0.0'; // overhead 2048
      // availableMB = 16384 - 2048 = 14336 >= 8192 -> 'normal'

      expect(getMemoryPressureStatus()).toBe('normal');
    });

    test('returns "moderate" when availableMB >= 4096 and < 8192', () => {
      // 8GB device, Chrome: availableMB = 8192 - 2048 = 6144
      // 6144 >= 4096 is TRUE, 6144 >= 8192 is FALSE -> 'moderate'
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      expect(getMemoryPressureStatus()).toBe('moderate');
    });

    test('returns "critical" when availableMB < 4096', () => {
      mockNavigator.deviceMemory = 4;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';
      // availableMB = 4096 - 2048 = 2048 < 4096 -> 'critical'

      expect(getMemoryPressureStatus()).toBe('critical');
    });
  });

  describe('formatMemoryIndicator', () => {
    test('produces readable text for "normal" status', () => {
      const budget: MemoryBudget = {
        totalMB: 16384,
        availableMB: 14336,
        browserOverheadMB: 2048,
      };

      const result = formatMemoryIndicator('normal', budget);

      expect(result).toBe('Memory: 14.0GB available — Full feature set enabled');
    });

    test('produces readable text for "moderate" status', () => {
      const budget: MemoryBudget = {
        totalMB: 8192,
        availableMB: 6144,
        browserOverheadMB: 2048,
      };

      const result = formatMemoryIndicator('moderate', budget);

      expect(result).toBe('Memory: 6.0GB available — Reduced mode (reranking disabled)');
    });

    test('produces readable text for "critical" status', () => {
      const budget: MemoryBudget = {
        totalMB: 4096,
        availableMB: 2048,
        browserOverheadMB: 2048,
      };

      const result = formatMemoryIndicator('critical', budget);

      expect(result).toBe('Memory: 2.0GB available — Minimal mode (reduced chunk limit)');
    });

    test('handles fractional GB values correctly', () => {
      const budget: MemoryBudget = {
        totalMB: 8192,
        availableMB: 7168,
        browserOverheadMB: 1024,
      };

      const result = formatMemoryIndicator('normal', budget);

      expect(result).toBe('Memory: 7.0GB available — Full feature set enabled');
    });
  });

  describe('integration scenarios', () => {
    test('8GB Chrome device uses MEDIUM tier correctly', () => {
      mockNavigator.deviceMemory = 8;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      const status = getMemoryPressureStatus();
      const config = selectModelTier(budget.availableMB);

      // 8GB Chrome: availableMB = 6144
      expect(budget.availableMB).toBe(6144);
      // 6144 >= 4096 -> moderate
      expect(status).toBe('moderate');
      // 6144 >= 4096 -> MEDIUM tier
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(5000);
    });

    test('16GB Chrome device uses HIGH tier correctly', () => {
      mockNavigator.deviceMemory = 16;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      const status = getMemoryPressureStatus();
      const config = selectModelTier(budget.availableMB);

      // 16GB Chrome: availableMB = 16384 - 2048 = 14336
      expect(budget.availableMB).toBe(14336);
      // 14336 >= 8192 -> normal
      expect(status).toBe('normal');
      // 14336 >= 8192 -> HIGH tier
      expect(config.rerankingEnabled).toBe(true);
      expect(config.maxChunkCount).toBe(10000);
    });

    test('2GB device uses LOW tier correctly', () => {
      mockNavigator.deviceMemory = 2;
      mockNavigator.userAgent = 'Chrome/120.0.0.0';

      const budget = getMemoryBudget();
      const status = getMemoryPressureStatus();
      const config = selectModelTier(budget.availableMB);

      // 2GB Chrome: availableMB = 2048 - 2048 = 0
      expect(budget.availableMB).toBe(0);
      // 0 >= 4096 -> FALSE -> critical
      expect(status).toBe('critical');
      // 0 < 4096 -> LOW tier
      expect(config.rerankingEnabled).toBe(false);
      expect(config.maxChunkCount).toBe(1000);
    });
  });
});
