// NVIDIA OpenShell runner adapter (stub for future multi-tenant VPS deployments).
//
// Registered in the pluggable runner interface so buzz-host and the plugin share
// one runner contract across host, docker, and future openshell backends.

export const openshellRunner = {
  id: "openshell",
  title: "NVIDIA OpenShell",
  sandboxed: true,

  async availability() {
    return {
      id: "openshell",
      title: "NVIDIA OpenShell",
      available: false,
      note: "Reserved for future multi-tenant VPS hosting (use Docker sandbox on this host).",
    };
  },

  validateSelectable() {
    throw new Error("NVIDIA OpenShell runner is not installed on this host yet; choose Docker sandbox.");
  },
};
