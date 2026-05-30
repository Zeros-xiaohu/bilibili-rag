"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { chatApi, knowledgeApi, KnowledgeStats, API_BASE_URL } from "@/lib/api";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ bvid: string; title: string; url: string }>;
}

interface Props {
  statsKey?: number;
  sessionId?: string;
  folderIds?: number[];
}

export default function ChatPanel({ statsKey, sessionId, folderIds }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const marker = "[[SOURCES_JSON]]";
  const contentStartMarker = "[[CONTENT_START]]";

  useEffect(() => {
    knowledgeApi.getStats().then(setStats).catch(() => { });
  }, [statsKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const q = input.trim();
    setInput("");
    const userId = Date.now().toString();
    const assistantId = (Date.now() + 1).toString();
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: q },
      { id: assistantId, role: "assistant", content: "", sources: [] },
    ]);
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/chat/ask/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: q,
          session_id: sessionId,
          folder_ids: folderIds,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error("流式接口不可用");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let done = false;
      let answerBuffer = "";
      let pendingBuffer = "";
      let metadataParsed = false;
      let legacySourcesJson = "";
      let inLegacySources = false;
      let pendingSources: Array<{ bvid: string; title: string; url: string }> = [];

      const parseSources = (raw: string) => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // 忽略解析错误，避免影响主文本
        }
        return [];
      };

      const revealSources = () => {
        if (pendingSources.length === 0) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, sources: pendingSources } : m
          )
        );
      };

      const applyContent = () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: answerBuffer } : m
          )
        );
      };

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          if (chunk) {
            if (!metadataParsed) {
              pendingBuffer += chunk;
              const markerIndex = pendingBuffer.indexOf(marker);
              const contentStartIndex = pendingBuffer.indexOf(contentStartMarker);

              if (markerIndex !== -1 && contentStartIndex !== -1 && markerIndex < contentStartIndex) {
                const rawSources = pendingBuffer.slice(markerIndex + marker.length, contentStartIndex);
                pendingSources = parseSources(rawSources);
                answerBuffer += pendingBuffer.slice(contentStartIndex + contentStartMarker.length);
                pendingBuffer = "";
                metadataParsed = true;
                applyContent();
              } else if (markerIndex === -1 && pendingBuffer.length > marker.length + contentStartMarker.length) {
                // 兼容没有元数据头的旧流式响应。
                answerBuffer += pendingBuffer;
                pendingBuffer = "";
                metadataParsed = true;
                applyContent();
              }
            } else {
              if (inLegacySources) {
                legacySourcesJson += chunk;
              } else {
                answerBuffer += chunk;
                const legacyMarkerIndex = answerBuffer.indexOf(marker);
                if (legacyMarkerIndex !== -1) {
                  legacySourcesJson = answerBuffer.slice(legacyMarkerIndex + marker.length);
                  answerBuffer = answerBuffer.slice(0, legacyMarkerIndex);
                  inLegacySources = true;
                }
              }
              applyContent();
            }
          }
        }
      }

      if (!metadataParsed && pendingBuffer) {
        const markerIndex = pendingBuffer.indexOf(marker);
        const contentStartIndex = pendingBuffer.indexOf(contentStartMarker);
        if (markerIndex !== -1 && contentStartIndex !== -1 && markerIndex < contentStartIndex) {
          pendingSources = parseSources(pendingBuffer.slice(markerIndex + marker.length, contentStartIndex));
          answerBuffer += pendingBuffer.slice(contentStartIndex + contentStartMarker.length);
        } else {
          answerBuffer += pendingBuffer;
        }
        applyContent();
      }
      if (legacySourcesJson) {
        pendingSources = parseSources(legacySourcesJson);
      }
      revealSources();
    } catch {
      try {
        const res = await chatApi.ask(q, sessionId, folderIds);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: res.answer, sources: res.sources } : m
          )
        );
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: `错误: ${err instanceof Error ? err.message : "请求失败"}`,
                }
              : m
          )
        );
      }
    }
    setLoading(false);
  };

  return (
    <div className="panel-inner">
      <div className="panel-header">
        <div>
          <div className="panel-title">对话工作台</div>
          {stats && stats.total_videos > 0 && (
            <div className="panel-subtitle">已收录 {stats.total_videos} 个视频</div>
          )}
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="btn btn-ghost" title="清空">
            清空对话
          </button>
        )}
      </div>

      <div className="panel-body">
        <div className="chat-scroll">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div>
                <div className="status-pill">检索就绪</div>
                <p className="text-sm text-[var(--muted)] mt-3">把收藏夹变成可提问的知识库</p>
              </div>
              <div className="prompt-grid">
                {[
                  "总结收藏夹里最有价值的内容",
                  "有哪些适合快速复习的系列？",
                  "列出与某个主题相关的视频并给出关键点",
                  "按主题整理我的收藏夹内容",
                  "用一句话概括每个视频的重点",
                  "推荐3个最适合入门的学习视频",
                ].map((q, i) => (
                  <button key={i} onClick={() => setInput(q)} className="prompt-chip">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-window">
              {messages.map((m) => (
                <div key={m.id} className={`message ${m.role}`}>
                  <div className="message-bubble">
                    <ReactMarkdown className="markdown" remarkPlugins={[remarkGfm]}>
                      {m.content}
                    </ReactMarkdown>
                    {m.sources && m.sources.length > 0 && (
                      <div className="source-list">
                        {m.sources.map((s, i) => (
                          <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="source-link">
                            {s.title}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="message assistant">
                  <div className="message-bubble">
                    <div className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </div>

      <div className="panel-footer">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder="输入问题..."
            className="input"
          />
          <button onClick={send} disabled={!input.trim() || loading} className="btn btn-primary">
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
