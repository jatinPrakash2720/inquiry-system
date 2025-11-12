'use client';

import { useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refinedQuery, setRefinedQuery] = useState<string | null>(null);
  const [showPopup, setShowPopup] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setIsLoading(true);

    // Add user message to chat and empty assistant message for streaming
    const currentLength = messages.length;
    const assistantMessageIndex = currentLength + 1; // user message + assistant message
    
    setMessages(prev => {
      const updated: Message[] = [...prev, { role: 'user' as const, content: userMessage }];
      updated.push({ role: 'assistant' as const, content: '' });
      return updated;
    });

    try {
      let response;
      
      if (!conversationId) {
        // Start new conversation with streaming
        response = await fetch('/api/chat/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: userMessage, stream: true }),
        });
      } else {
        // Continue conversation with streaming
        response = await fetch('/api/chat/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            conversation_id: conversationId,
            answer: userMessage,
            stream: true
          }),
        });
      }

      if (!response.ok) {
        const errorData = await response.json();
        setMessages(prev => {
          const updated: Message[] = [...prev];
          updated[assistantMessageIndex] = { 
            role: 'assistant' as const, 
            content: `Error: ${errorData.error || 'Something went wrong'}` 
          };
          return updated;
        });
        setIsLoading(false);
        return;
      }

      // Handle SSE streaming
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';

      if (!reader) {
        throw new Error('No reader available');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.type === 'token') {
                accumulatedContent += data.content;
                
                // Check if chunk contains @FINAL_QUERY: prefix
                if (accumulatedContent.includes('@FINAL_QUERY:') || accumulatedContent.toLowerCase().includes('@final_query:')) {
                  // Extract query after @FINAL_QUERY:
                  const match = accumulatedContent.match(/@FINAL_QUERY:\s*(.+?)(?:\n\n|\n$|$)/i);
                  if (match) {
                    const query = match[1].trim().split('\n')[0].trim();
                    const formattedQuery = `User wants to say this: ${query}`;
                    setRefinedQuery(formattedQuery);
                    setShowPopup(true);
                    setConversationId(null);
                    setMessages(prev => {
                      const updated = [...prev];
                      updated[assistantMessageIndex] = { 
                        role: 'assistant', 
                        content: 'Here\'s your refined query!' 
                      };
                      return updated;
                    });
                    setIsLoading(false);
                    return;
                  }
                }
                
                setMessages(prev => {
                  const updated: Message[] = [...prev];
                  updated[assistantMessageIndex] = { 
                    role: 'assistant' as const, 
                    content: accumulatedContent 
                  };
                  return updated;
                });
              } else if (data.type === 'done') {
                setConversationId(data.conversation_id);
                setIsLoading(false);
                return;
              } else if (data.type === 'final_query') {
                // Stop streaming and show popup
                setRefinedQuery(data.refined_query);
                setShowPopup(true);
                setConversationId(null);
                // Replace the message with just a simple confirmation
                setMessages(prev => {
                  const updated: Message[] = [...prev];
                  updated[assistantMessageIndex] = { 
                    role: 'assistant' as const, 
                    content: 'Here\'s your refined query!' 
                  };
                  return updated;
                });
                setIsLoading(false);
                return;
              } else if (data.type === 'error') {
                setMessages(prev => {
                  const updated: Message[] = [...prev];
                  updated[assistantMessageIndex] = { 
                    role: 'assistant' as const, 
                    content: `Error: ${data.content}` 
                  };
                  return updated;
                });
                setIsLoading(false);
                return;
              }
            } catch (e) {
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error:', error);
      setMessages(prev => {
        const updated: Message[] = [...prev];
        updated[assistantMessageIndex] = { 
          role: 'assistant' as const, 
          content: 'Sorry, something went wrong. Please try again.' 
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setConversationId(null);
    setRefinedQuery(null);
    setInput('');
    setShowPopup(false);
  };

  const handleClosePopup = () => {
    setShowPopup(false);
  };

  return (
    <div className="flex min-h-screen bg-black text-white">
      {/* Popup Modal */}
      {showPopup && refinedQuery && (
        <div 
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={handleClosePopup}
        >
          <div 
            className="bg-zinc-900 border border-zinc-800 rounded-lg max-w-2xl w-full p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-xl font-semibold text-white">System Reference</h2>
                <p className="text-sm text-zinc-400 mt-1">Use this as a reference for search</p>
              </div>
              <button
                onClick={handleClosePopup}
                className="text-zinc-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="bg-black border border-zinc-800 rounded-lg p-4 mb-4">
              <p className="text-white text-lg leading-relaxed font-mono text-sm">{refinedQuery}</p>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={handleClosePopup}
                className="px-4 py-2 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleReset}
                className="px-4 py-2 bg-white text-black rounded-lg hover:bg-zinc-100 transition-colors font-medium"
              >
                Start New Conversation
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex w-full flex-col max-w-4xl mx-auto">
        {/* Header */}
        <header className="border-b border-zinc-800 px-6 py-4">
          <h1 className="text-2xl font-semibold text-white">Inquiry System</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Ask your question and I'll help refine it
          </p>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-8 space-y-6">
          {messages.length === 0 && (
            <div className="text-center text-zinc-400 mt-12">
              <p className="text-lg">Start a conversation to begin</p>
            </div>
          )}
          
          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 ${
                  message.role === 'user'
                    ? 'bg-white text-black'
                    : 'bg-zinc-900 text-white border border-zinc-800'
                }`}
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {message.content || (isLoading && index === messages.length - 1 ? '...' : '')}
                </p>
              </div>
            </div>
          ))}

          {/* Loading indicator removed - streaming messages update in real-time */}

          {refinedQuery && (
            <div className="mt-6 p-4 bg-zinc-900 border border-zinc-700 rounded-lg">
              <p className="text-sm font-medium text-zinc-300 mb-2">Final Refined Query:</p>
              <p className="text-white font-medium">{refinedQuery}</p>
            </div>
          )}
        </div>

        {/* Input Form */}
        <div className="border-t border-zinc-800 px-6 py-4 bg-black">
          {refinedQuery && (
            <button
              onClick={handleReset}
              className="mb-3 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Start New Conversation
            </button>
          )}
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={refinedQuery ? "Start a new conversation..." : "Type your message..."}
              disabled={isLoading || !!refinedQuery}
              className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-700 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim() || !!refinedQuery}
              className="px-6 py-3 bg-white text-black rounded-lg font-medium hover:bg-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
