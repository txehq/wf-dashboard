import { guardBasicTier } from './basic-tier.js';

// local 项目的 setupFiles：在任何测试模块读取 config 与 gateway 设置之前生效
guardBasicTier();
