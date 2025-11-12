import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { conversation_id, answer, stream } = await request.json();

    if (!conversation_id || !answer) {
      return NextResponse.json(
        { error: "conversation_id and answer are required" },
        { status: 400 }
      );
    }

    const url = stream
      ? `${process.env.NEXT_PUBLIC_API_URL}/inquire/continue/stream`
      : `${process.env.NEXT_PUBLIC_API_URL}/inquire/continue`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conversation_id, answer }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Backend error: ${errorText}` },
        { status: response.status }
      );
    }

    if (stream) {
      return new Response(response.body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error in /api/chat/continue:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
