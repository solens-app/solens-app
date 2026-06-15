"use client";

import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";

export default function Home() {
  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      <Sidebar />
      <ChatArea />
    </div>
  );
}
