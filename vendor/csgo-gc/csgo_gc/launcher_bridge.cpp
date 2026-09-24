#include "stdafx.h"
#include "launcher_bridge.h"

#ifdef _WIN32
#include <Windows.h>
#endif

namespace
{

constexpr uint32_t BridgeMagic = 0x31473242; // ASCII "B2G1" in little endian.
constexpr uint16_t BridgeVersion = 1;
constexpr uint32_t MaxBridgePayload = 64 * 1024;
constexpr size_t MaxQueuedMessages = 32;

#pragma pack(push, 1)
struct BridgeHeader
{
    uint32_t magic;
    uint16_t version;
    uint16_t type;
    uint32_t payloadSize;
};
#pragma pack(pop)

static_assert(sizeof(BridgeHeader) == 12);

#ifdef _WIN32
constexpr wchar_t BridgePipeName[] = L"\\\\.\\pipe\\B2G.Launcher.v1";
std::wstring EffectiveBridgePipeName()
{
#ifdef B2G_LAUNCHER_BRIDGE_TESTING
    return L"\\\\.\\pipe\\B2G.Launcher.Tests." + std::to_wstring(GetCurrentProcessId());
#else
    return BridgePipeName;
#endif
}

bool ReadExact(HANDLE pipe, void *data, uint32_t size)
{
    auto *cursor = static_cast<uint8_t *>(data);
    uint32_t remaining = size;
    while (remaining)
    {
        DWORD read = 0;
        if (!ReadFile(pipe, cursor, remaining, &read, nullptr) || read == 0)
        {
            return false;
        }
        cursor += read;
        remaining -= read;
    }
    return true;
}

bool WriteExact(HANDLE pipe, const void *data, uint32_t size)
{
    const auto *cursor = static_cast<const uint8_t *>(data);
    uint32_t remaining = size;
    while (remaining)
    {
        DWORD written = 0;
        if (!WriteFile(pipe, cursor, remaining, &written, nullptr) || written == 0)
        {
            return false;
        }
        cursor += written;
        remaining -= written;
    }
    return true;
}

bool SendFrame(HANDLE pipe, LauncherBridge::MessageType type, const void *data, uint32_t size)
{
    BridgeHeader header{ BridgeMagic, BridgeVersion, static_cast<uint16_t>(type), size };
    return WriteExact(pipe, &header, sizeof(header))
        && (!size || WriteExact(pipe, data, size));
}
#endif

} // namespace

LauncherBridge::LauncherBridge(SharedGC &gc, uint64_t steamId)
    : m_gc{ gc }
    , m_steamId{ steamId }
    , m_thread{ &LauncherBridge::Worker, this }
{
}

LauncherBridge::~LauncherBridge()
{
    m_stopping.store(true);
    if (m_thread.joinable())
    {
        m_thread.join();
    }
}

bool LauncherBridge::Send(MessageType type, const void *data, uint32_t size)
{
    if (size > MaxBridgePayload || (size && !data))
    {
        Platform::Print("LauncherBridge: rejected invalid outbound frame type=%u size=%u\n",
            static_cast<unsigned>(type), size);
        return false;
    }
    if (!m_connected.load(std::memory_order_acquire))
    {
        Platform::Print("LauncherBridge: ignored outbound frame while launcher is disconnected\n");
        return false;
    }
    OutboundMessage message{ type, {} };
    if (size)
    {
        const auto *bytes = static_cast<const uint8_t *>(data);
        message.payload.assign(bytes, bytes + size);
    }
    std::lock_guard lock{ m_outboundMutex };
    if (!m_connected.load(std::memory_order_acquire))
    {
        return false;
    }
    if (m_outbound.size() >= MaxQueuedMessages)
    {
        m_outbound.erase(m_outbound.begin());
    }
    m_outbound.push_back(std::move(message));
    return true;
}

void LauncherBridge::Worker()
{
#ifndef _WIN32
    Platform::Print("LauncherBridge: local launcher IPC is unavailable on this platform\n");
#else
    while (!m_stopping.load())
    {
        const std::wstring pipeName = EffectiveBridgePipeName();
        if (!WaitNamedPipeW(pipeName.c_str(), 500))
        {
            std::this_thread::sleep_for(std::chrono::milliseconds{ 500 });
            continue;
        }
        HANDLE pipe = CreateFileW(pipeName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
            OPEN_EXISTING, 0, nullptr);
        if (pipe == INVALID_HANDLE_VALUE)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds{ 500 });
            continue;
        }

        Platform::Print("LauncherBridge: connected to B2G Launcher\n");
        if (!SendFrame(pipe, MessageType::ClientHello, &m_steamId, sizeof(m_steamId)))
        {
            CloseHandle(pipe);
            continue;
        }
        m_connected.store(true, std::memory_order_release);
        m_gc.PostToGC(GCEvent::LauncherBridgeConnection, 1, nullptr, 0);

        bool connected = true;
        while (connected && !m_stopping.load())
        {
            std::vector<OutboundMessage> outbound;
            {
                std::lock_guard lock{ m_outboundMutex };
                outbound.swap(m_outbound);
            }
            for (const OutboundMessage &message : outbound)
            {
                if (!SendFrame(pipe, message.type, message.payload.data(),
                        static_cast<uint32_t>(message.payload.size())))
                {
                    connected = false;
                    break;
                }
            }
            if (!connected)
            {
                break;
            }

            DWORD available = 0;
            if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr))
            {
                break;
            }
            if (available < sizeof(BridgeHeader))
            {
                std::this_thread::sleep_for(std::chrono::milliseconds{ 50 });
                continue;
            }

            BridgeHeader header{};
            if (!ReadExact(pipe, &header, sizeof(header)))
            {
                break;
            }
            if (header.magic != BridgeMagic || header.version != BridgeVersion
                || header.payloadSize > MaxBridgePayload)
            {
                Platform::Print("LauncherBridge: invalid inbound frame\n");
                break;
            }
            std::vector<uint8_t> payload(header.payloadSize);
            if (header.payloadSize && !ReadExact(pipe, payload.data(), header.payloadSize))
            {
                break;
            }
            m_gc.PostToGC(GCEvent::LauncherBridgeMessage, header.type,
                payload.data(), static_cast<uint32_t>(payload.size()));
        }

        m_connected.store(false, std::memory_order_release);
        m_gc.PostToGC(GCEvent::LauncherBridgeConnection, 0, nullptr, 0);
        {
            std::lock_guard lock{ m_outboundMutex };
            m_outbound.clear();
        }
        CloseHandle(pipe);
        Platform::Print("LauncherBridge: disconnected from B2G Launcher\n");
    }
#endif
}
