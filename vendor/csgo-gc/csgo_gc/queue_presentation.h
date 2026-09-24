#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>

// Presentation only: never authorizes a queue entry or server connection.
// Correlated replies keep an old join response from undoing a newer cancellation.
class QueuePresentation
{
public:
    uint64_t Start(uint32_t authoritativePhase)
    {
        if (m_pending || (m_error.empty() && authoritativePhase >= 1 && authoritativePhase <= 3))
            return 0;
        return Begin(true);
    }

    uint64_t Stop()
    {
        if (m_pending && !*m_pending) return 0;
        return Begin(false);
    }

    bool Reply(uint64_t requestId, std::string error)
    {
        if (!m_pending || requestId != m_requestId) return false;
        m_pending.reset();
        m_error = std::move(error);
        return true;
    }

    uint32_t Phase(uint32_t authoritativePhase) const
    {
        if (m_pending) return *m_pending ? 1 : 0;
        return m_error.empty() ? authoritativePhase : 0;
    }
    bool Cancelling() const { return m_pending && !*m_pending; }
    const std::string &Error() const { return m_error; }
    void ConnectionChanged(bool connected)
    {
        m_pending.reset();
        m_error = connected ? "" : "B2G Launcher disconnected. Reopen it to check your queue.";
    }

private:
    uint64_t Begin(bool start)
    {
        if (++m_requestId == 0) ++m_requestId;
        m_pending = start;
        m_error.clear();
        return m_requestId;
    }
    uint64_t m_requestId{};
    std::optional<bool> m_pending;
    std::string m_error;
};
