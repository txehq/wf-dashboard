import { guardBasicTier } from './basic-tier.js';

// local 项目（基础档）的 setupFiles：在任何测试模块读取 config 与 gateway 设置之前生效；基础档不依赖网络
guardBasicTier({ offline: true });
