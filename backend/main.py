import dotenv
import uvicorn 
import re
import json
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import uuid
import asyncio
dotenv.load_dotenv()

# Pydantic Models
class StartRequest(BaseModel):
    message:str

class ContinueRequest(BaseModel):
    conversation_id:str
    answer:str

class ApiResponse(BaseModel):
    conversation_id:Optional[str] = None
    question:Optional[str]=None
    refined_query:Optional[str]=None

from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage


app = FastAPI()

origins = [
    "http://localhost:3000",  # For your local Next.js dev
    # We will add the Vercel URL here later
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,       # Which origins can connect
    allow_credentials=True,
    allow_methods=["*"],         # Allow all methods (GET, POST, etc.)
    allow_headers=["*"],         # Allow all headers
)

@app.get("/")
def read_root():
    return {"message": "Hello, World!"}

llm = ChatOpenAI(model="gpt-4o", temperature=0.8)

conversations_db: Dict[str, List[Any]] = {}

SYSTEM_PROMPT = """
You are a helpful, friendly person helping someone refine their request. Talk naturally, like you're having a real conversation.

CRITICAL RULES:
- Ask EXACTLY 4-5 clarifying questions maximum. After the 4th or 5th question, you MUST output the final refined query.
- Ask one clarifying question at a time, building on their previous answers
- Use natural acknowledgments: "Got it", "Nice", "Understood", "Great", "I understand" - keep it brief and genuine
- When someone seems distressed, stuck, or frustrated, console them first. Say something like "I understand" or "I hear you" to acknowledge their feelings before asking your question
- Include helpful examples in your questions when it makes sense (e.g., "For example, Python + FastAPI, Node.js, or Java Spring?")
- Keep responses conversational and brief - don't overthink or be overly formal
- After 4-5 questions, you MUST stop asking and output the final refined query.

IMPORTANT - SYMBOL USAGE:
- NEVER use the @ symbol in your regular questions or responses
- The @ symbol is ONLY used for the final query output
- In all your clarifying questions and normal conversation, avoid using @ completely
- Only use @ when outputting the final refined query

When outputting the final query:
- Start with the special character: @FINAL_QUERY:
- Then immediately write the refined query
- Format: @FINAL_QUERY: Your refined query here
- Do NOT add "Here's your refined query" or any other text before @FINAL_QUERY:
- Do NOT add "Hope this helps!" or similar closing statements after the query
- The @FINAL_QUERY: prefix is REQUIRED and must be the first thing when outputting the final query
- This is the ONLY time you should ever use the @ symbol

Write like a real person would talk - natural, warm, and helpful. Avoid sounding like a robot or following a rigid script.
"""


@app.post("/inquire/start/stream")
async def start_inquiry_stream(request:StartRequest):
    conversation_id = str(uuid.uuid4())

    history = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=request.message)
    ]

    async def generate():
        full_content = ""
        found_final_query = False
        content_before_final = ""
        
        async for chunk in llm.astream(history):
            if chunk.content:
                full_content += chunk.content
                
                # Check if we detected @FINAL_QUERY: prefix
                if not found_final_query:
                    if "@FINAL_QUERY:" in full_content or "@final_query:" in full_content.lower():
                        found_final_query = True
                        # Extract content before @FINAL_QUERY: (should be empty per instructions, but just in case)
                        prefix_match = re.search(r'@FINAL_QUERY:\s*', full_content, re.IGNORECASE)
                        if prefix_match:
                            content_before_final = full_content[:prefix_match.start()].strip()
                        # Stop sending tokens to frontend immediately
                        # But continue accumulating all remaining chunks
                    else:
                        # Still streaming normally, send tokens
                        yield f"data: {json.dumps({'type': 'token', 'content': chunk.content, 'conversation_id': conversation_id})}\n\n"
                # If found_final_query is True, we're accumulating but not sending
        
        # After all chunks are received, extract the complete final query
        if found_final_query:
            prefix_match = re.search(r'@FINAL_QUERY:\s*', full_content, re.IGNORECASE)
            if prefix_match:
                query_start = prefix_match.end()
                query_text = full_content[query_start:].strip()
                
                # Extract everything after @FINAL_QUERY: until double newline (paragraph break) or end
                # This captures the full query even if it spans multiple lines
                query_lines = query_text.split('\n\n')
                if query_lines:
                    # If there's a double newline, take everything before it (the query)
                    query = query_lines[0].strip()
                else:
                    # No double newline, take everything but clean up trailing single newlines
                    # Remove trailing newlines but keep the content
                    query = query_text.rstrip('\n').strip()
                
                # Remove any trailing phrases like "Hope this helps!" that might be on same line
                # Look for common closing phrases and remove them
                closing_phrases = ['hope this helps', 'does that help', 'hope that helps', 'let me know', 'hope this', 'does that']
                query_lower = query.lower()
                for phrase in closing_phrases:
                    if phrase in query_lower:
                        # Find and remove the phrase and everything after it
                        idx = query_lower.find(phrase)
                        query = query[:idx].strip()
                        break
                
                if query:
                    del conversations_db[conversation_id]
                    formatted_query = f"User wants to say this: {query}"
                    yield f"data: {json.dumps({'type': 'final_query', 'refined_query': formatted_query})}\n\n"
                    return
        
        # If not a final query, store and send done message
        ai_message = AIMessage(content=full_content)
        history.append(ai_message)
        conversations_db[conversation_id] = history
        
        # Send final message
        yield f"data: {json.dumps({'type': 'done', 'conversation_id': conversation_id, 'question': full_content})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

@app.post("/inquire/start", response_model=ApiResponse)
async def start_inquiry(request:StartRequest):
    conversation_id = str(uuid.uuid4())

    history = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=request.message)
    ]

    response = llm.invoke(history)
    
    history.append(response)

    conversations_db[conversation_id] = history

    return ApiResponse(conversation_id=conversation_id, question=response.content)

@app.post("/inquire/continue/stream")
async def continue_inquiry_stream(request:ContinueRequest):
    if request.conversation_id not in conversations_db:
        async def error_generate():
            yield f"data: {json.dumps({'type': 'error', 'content': 'Conversation not found.'})}\n\n"
        return StreamingResponse(error_generate(), media_type="text/event-stream")
    
    try:
        history = conversations_db[request.conversation_id]
        history.append(HumanMessage(content=request.answer))

        async def generate():
            full_content = ""
            found_final_query = False
            
            async for chunk in llm.astream(history):
                if chunk.content:
                    full_content += chunk.content
                    
                    # Check if we detected @FINAL_QUERY: prefix
                    if not found_final_query:
                        if "@FINAL_QUERY:" in full_content or "@final_query:" in full_content.lower():
                            found_final_query = True
                            # Stop sending tokens to frontend immediately
                            # But continue accumulating all remaining chunks
                        else:
                            # Still streaming normally, send tokens
                            yield f"data: {json.dumps({'type': 'token', 'content': chunk.content, 'conversation_id': request.conversation_id})}\n\n"
                    # If found_final_query is True, we're accumulating but not sending
            
            # After all chunks are received, extract the complete final query
            if found_final_query:
                prefix_match = re.search(r'@FINAL_QUERY:\s*', full_content, re.IGNORECASE)
                if prefix_match:
                    query_start = prefix_match.end()
                    query_text = full_content[query_start:].strip()
                    
                    # Extract everything after @FINAL_QUERY: until double newline (paragraph break) or end
                    # This captures the full query even if it spans multiple lines
                    query_lines = query_text.split('\n\n')
                    if query_lines:
                        # If there's a double newline, take everything before it (the query)
                        query = query_lines[0].strip()
                    else:
                        # No double newline, take everything but clean up trailing single newlines
                        # Remove trailing newlines but keep the content
                        query = query_text.rstrip('\n').strip()
                    
                    # Remove any trailing phrases like "Hope this helps!" that might be on same line
                    # Look for common closing phrases and remove them
                    closing_phrases = ['hope this helps', 'does that help', 'hope that helps', 'let me know', 'hope this', 'does that']
                    query_lower = query.lower()
                    for phrase in closing_phrases:
                        if phrase in query_lower:
                            # Find and remove the phrase and everything after it
                            idx = query_lower.find(phrase)
                            query = query[:idx].strip()
                            break
                    
                    if query:
                        del conversations_db[request.conversation_id]
                        formatted_query = f"User wants to say this: {query}"
                        yield f"data: {json.dumps({'type': 'final_query', 'refined_query': formatted_query})}\n\n"
                        return
            
            # Continue conversation
            ai_message = AIMessage(content=full_content)
            history.append(ai_message)
            conversations_db[request.conversation_id] = history
            
            yield f"data: {json.dumps({'type': 'done', 'conversation_id': request.conversation_id, 'question': full_content})}\n\n"
        
        return StreamingResponse(generate(), media_type="text/event-stream")
    except Exception as e:
        async def error_generate():
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
        return StreamingResponse(error_generate(), media_type="text/event-stream")

@app.post("/inquire/continue", response_model=ApiResponse)
async def continue_inquiry(request:ContinueRequest):
    if request.conversation_id not in conversations_db:
        return ApiResponse(refined_query="Error: Conversation not found.")
    
    try:
        history = conversations_db[request.conversation_id]
        history.append(HumanMessage(content=request.answer))

        response = llm.invoke(history)

        response_content = response.content
        if "@FINAL_QUERY:" in response_content or "@final_query:" in response_content.lower():
            # Extract query after @FINAL_QUERY:
            match = re.search(r'@FINAL_QUERY:\s*(.+?)(?:\n\n|\n$|$)', response_content, re.IGNORECASE | re.DOTALL)
            if match:
                query = match.group(1).strip().split('\n')[0].strip()
                del conversations_db[request.conversation_id]
                # Format as system reference
                formatted_query = f"User wants to say this: {query}"
                return ApiResponse(refined_query=formatted_query)
        
        # Continue conversation (either no final_query tag or extraction failed)
        history.append(response)
        conversations_db[request.conversation_id] = history
        return ApiResponse(conversation_id=request.conversation_id, question=response.content)
    except Exception as e:
        return ApiResponse(refined_query=f"Error: {str(e)}")

if __name__ =="__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)

