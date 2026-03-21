import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const resolveNewsFeedBackendDir = (): string => {
  const configured = process.env.TRADINGNEWSFEED_BACKEND_DIR?.trim();
  if (configured) return configured;
  return path.resolve(process.cwd(), "../tradingnewsfeed/backend");
};

const runNewsCommand = async (command: "status" | "poll" | "pause" | "resume") => {
  const cwd = resolveNewsFeedBackendDir();
  const { stdout, stderr } = await execFileAsync("npm", ["run", command], { cwd, env: process.env, timeout: 45_000 });
  if (stderr?.trim()) {
    console.warn("news feed command stderr", { command, stderr });
  }
  return stdout.trim();
};

export const getNewsFeedStatus = async (): Promise<string> => runNewsCommand("status");
export const pollNewsFeedNow = async (): Promise<string> => runNewsCommand("poll");
export const pauseNewsFeed = async (): Promise<string> => runNewsCommand("pause");
export const resumeNewsFeed = async (): Promise<string> => runNewsCommand("resume");
