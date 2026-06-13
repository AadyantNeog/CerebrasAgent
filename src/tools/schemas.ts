import {z} from 'zod';

export const pathArgsSchema = z.object({
  path: z.string().min(1)
});

export const searchArgsSchema = z.object({
  query: z.string().min(1),
  glob: z.string().optional()
});

export const createFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const editFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const applyPatchArgsSchema = z.object({
  path: z.string().min(1),
  patch: z.string().min(1)
});

export const runCommandArgsSchema = z.object({
  command: z.string().min(1)
});

export type PathArgs = z.infer<typeof pathArgsSchema>;
export type SearchArgs = z.infer<typeof searchArgsSchema>;
export type CreateFileArgs = z.infer<typeof createFileArgsSchema>;
export type EditFileArgs = z.infer<typeof editFileArgsSchema>;
export type ApplyPatchArgs = z.infer<typeof applyPatchArgsSchema>;
export type RunCommandArgs = z.infer<typeof runCommandArgsSchema>;
