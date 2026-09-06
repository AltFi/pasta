#include <Communication/Communication.hpp>
#include <Exploit/TaskScheduler/TaskScheduler.hpp>

bool ReadExactSocket(SOCKET Socket, void* Buffer, size_t Size)
{
    size_t Total = 0;
    char* Out = static_cast<char*>(Buffer);
    while (Total < Size)
    {
        int Received = recv(Socket, Out + Total, static_cast<int>(Size - Total), 0);
        if (Received <= 0)
            return false;

        Total += static_cast<size_t>(Received);
    }

    return true;
}

bool WriteExactSocket(SOCKET Socket, const void* Buffer, size_t Size)
{
    const char* Data = static_cast<const char*>(Buffer);
    size_t Total = 0;
    while (Total < Size)
    {
        int Sent = send(Socket, Data + Total, static_cast<int>(Size - Total), 0);
        if (Sent <= 0)
            return false;

        Total += static_cast<size_t>(Sent);
    }

    return true;
}

// Response framing mirrors the request: a 4-byte big-endian length prefix
// (matching ntohl() below, same as the request side) followed by raw
// UTF-8 payload bytes. Previously there was no response at all -- the
// client had no way to tell "the engine received this" from "nothing is
// listening," which made any success/failure reporting on the client
// side fundamentally unverifiable, not just imprecise.
//
// This acknowledges "received and queued for execution," not "executed
// successfully" -- RequestExecution() only enqueues the script;
// TaskScheduler.cpp's ScriptsHandler actually runs it later, on Roblox's
// own render thread, and there is currently no plumbing to carry that
// later result back to this (already-closed) connection. That's a
// separate, larger change (keeping the connection open and correlating
// the eventual execution result back to it) -- not done here. This ack
// is still a real, meaningful signal: it proves the engine is alive and
// the script was actually accepted, which is strictly more than "no
// response at all" gave the client before.
void SendResponse(SOCKET Socket, const std::string& Payload)
{
    uint32_t NetLen = htonl(static_cast<uint32_t>(Payload.size()));
    if (!WriteExactSocket(Socket, &NetLen, sizeof(NetLen)))
        return;

    WriteExactSocket(Socket, Payload.data(), Payload.size());
}

void TcpServer()
{
    WSADATA Wsa;
    if (WSAStartup(MAKEWORD(2, 2), &Wsa) != 0)
        return;

    SOCKET ListenSocket = INVALID_SOCKET;
    SOCKET ClientSocket = INVALID_SOCKET;

    addrinfo Hints{};
    addrinfo* Result = nullptr;

    Hints.ai_family = AF_INET;
    Hints.ai_socktype = SOCK_STREAM;
    Hints.ai_protocol = IPPROTO_TCP;
    Hints.ai_flags = AI_PASSIVE;

    if (getaddrinfo("127.0.0.1", "6969", &Hints, &Result) != 0)
    {
        WSACleanup();
        return;
    }

    ListenSocket = socket(Result->ai_family, Result->ai_socktype, Result->ai_protocol);
    if (ListenSocket == INVALID_SOCKET)
    {
        freeaddrinfo(Result);
        WSACleanup();
        return;
    }

    BOOL Opt = TRUE;
    setsockopt(ListenSocket, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&Opt), sizeof(Opt));
    if (bind(ListenSocket, Result->ai_addr, static_cast<int>(Result->ai_addrlen)) == SOCKET_ERROR)
    {
        closesocket(ListenSocket);
        freeaddrinfo(Result);
        WSACleanup();
        return;
    }

    freeaddrinfo(Result);
    if (listen(ListenSocket, SOMAXCONN) == SOCKET_ERROR)
    {
        closesocket(ListenSocket);
        WSACleanup();
        return;
    }

    while (true)
    {
        ClientSocket = accept(ListenSocket, nullptr, nullptr);
        if (ClientSocket == INVALID_SOCKET)
        {
            Sleep(100);
            continue;
        }

        uint32_t NetLen = 0;
        if (!ReadExactSocket(ClientSocket, &NetLen, sizeof(NetLen)))
        {
            closesocket(ClientSocket);
            continue;
        }

        uint32_t ScriptLen = ntohl(NetLen);
        if (ScriptLen == 0 || ScriptLen > (8 * 1024 * 1024))
        {
            SendResponse(ClientSocket, "ERR:invalid script length");
            closesocket(ClientSocket);
            continue;
        }

        std::vector<char> Buffer(ScriptLen);
        if (!ReadExactSocket(ClientSocket, Buffer.data(), ScriptLen))
        {
            closesocket(ClientSocket);
            continue;
        }

        std::string Script(Buffer.data(), Buffer.size());
        TaskScheduler::RequestExecution(Script);

        SendResponse(ClientSocket, "OK:queued");
        closesocket(ClientSocket);
    }

    closesocket(ListenSocket);
    WSACleanup();
}

void Communication::Initialize()
{
    std::thread(TcpServer).detach();
}