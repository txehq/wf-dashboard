import { guardBasicTier } from './basic-tier.js';

// slow 项目（慢档）的 setupFiles：与基础档相同地拦截真实模型、claude 与 Codex；只读的 gh 照常可用
guardBasicTier({ offline: false });
