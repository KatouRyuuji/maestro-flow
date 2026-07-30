import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Switch } from 'react-router-dom';
import { AppLayout } from '@/client/components/layout/AppLayout.js';

const KanbanPage = lazy(() =>
  import('@/client/pages/KanbanPage.js').then((m) => ({ default: m.KanbanPage }))
);
const ArtifactsPage = lazy(() =>
  import('@/client/pages/ArtifactsPage.js').then((m) => ({ default: m.ArtifactsPage }))
);
const ChatPage = lazy(() =>
  import('@/client/pages/chat/ChatPage.js').then((m) => ({ default: m.ChatPage })),
);
const WorkflowPage = lazy(() =>
  import('@/client/pages/WorkflowPage.js').then((m) => ({ default: m.WorkflowPage })),
);
const McpPage = lazy(() =>
  import('@/client/pages/McpPage.js').then((m) => ({ default: m.McpPage })),
);
const SpecsPage = lazy(() =>
  import('@/client/pages/SpecsPage.js').then((m) => ({ default: m.SpecsPage })),
);
const TeamsPage = lazy(() =>
  import('@/client/pages/TeamsPage.js').then((m) => ({ default: m.TeamsPage })),
);
const RequirementPage = lazy(() =>
  import('@/client/pages/RequirementPage.js').then((m) => ({ default: m.RequirementPage })),
);
const RequirementBoardPage = lazy(() =>
  import('@/client/pages/RequirementBoardPage.js').then((m) => ({ default: m.RequirementBoardPage })),
);
const MaestroCoordinatePage = lazy(() =>
  import('@/client/pages/MaestroCoordinatePage.js').then((m) => ({ default: m.MaestroCoordinatePage })),
);
const CollabPage = lazy(() =>
  import('@/client/pages/CollabPage.js').then((m) => ({ default: m.CollabPage })),
);
const MeetingRoomPage = lazy(() =>
  import('@/client/pages/MeetingRoomPage.js').then((m) => ({ default: m.MeetingRoomPage })),
);
const RoomsPage = lazy(() =>
  import('@/client/pages/RoomsPage.js').then((m) => ({ default: m.RoomsPage })),
);

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full text-text-tertiary text-[length:var(--font-size-sm)]">
      Loading...
    </div>
  );
}

function Suspended({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LazyFallback />}>{children}</Suspense>;
}

export function App() {
  return (
    <BrowserRouter>
      <AppLayout>
        <Switch>
          <Route path="/">
            <Navigate to="/kanban" replace />
          </Route>
          <Route path="/kanban"><Suspended><KanbanPage /></Suspended></Route>
          <Route path="/artifacts"><Suspended><ArtifactsPage /></Suspended></Route>
          <Route path="/chat"><Suspended><ChatPage /></Suspended></Route>
          <Route path="/workflow"><Suspended><WorkflowPage /></Suspended></Route>
          <Route path="/mcp"><Suspended><McpPage /></Suspended></Route>
          <Route path="/specs"><Suspended><SpecsPage /></Suspended></Route>
          <Route path="/wiki"><Navigate to="/artifacts" replace /></Route>
          <Route path="/teams"><Suspended><TeamsPage /></Suspended></Route>
          <Route path="/requirement"><Suspended><RequirementPage /></Suspended></Route>
          <Route path="/requirement/:id/board"><Suspended><RequirementBoardPage /></Suspended></Route>
          <Route path="/maestro-coordinate"><Suspended><MaestroCoordinatePage /></Suspended></Route>
          <Route path="/collab"><Suspended><CollabPage /></Suspended></Route>
          <Route path="/rooms"><Suspended><RoomsPage /></Suspended></Route>
          <Route path="/meeting-room/:sessionId"><Suspended><MeetingRoomPage /></Suspended></Route>
          <Route><Navigate to="/kanban" replace /></Route>
        </Switch>
      </AppLayout>
    </BrowserRouter>
  );
}
