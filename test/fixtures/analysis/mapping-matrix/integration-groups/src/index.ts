// Real source usage: `react` and `vue` are declared (vue only as a peer), `zod` is not declared.
import type { ReactNode } from 'react';
import { createApp } from 'vue';
import { z } from 'zod';

export const view: ReactNode = z.string();
export const app = createApp;
