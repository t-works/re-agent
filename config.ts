// DeepSeek config — token comes from env (export DEEPSEEK_API_KEY=...)
export default {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-chat',
  maxIterations: 30,
};
