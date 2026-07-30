import { Suspense, lazy } from 'react';
import { I18nProvider } from './i18n/index.js';
import { VersionProvider, useVersion } from './version/index.js';
import { Layout } from './components/layout/Layout.js';
import { getAllCommands, getAllCategories, getCommandSlug, getInventory } from './routes/route-config.js';
import { BrowserRouter, Navigate, Route, Switch, useParams } from 'react-router-dom';

const LandingPage = lazy(() => import('./pages/LandingPage.js'));
const CategoryPage = lazy(() => import('./pages/CategoryPage.js'));
const CommandDetailPage = lazy(() => import('./pages/CommandDetailPage.js'));
const SkillDetailPage = lazy(() => import('./pages/SkillDetailPage.js'));
const SearchPage = lazy(() => import('./pages/SearchPage.js'));
const GuidePage = lazy(() => import('./pages/GuidePage.js'));
const ChangelogPage = lazy(() => import('./pages/ChangelogPage.js'));
const QuickStartPage = lazy(() => import('./pages/QuickStartPage.js'));

function GuideRouteWrapper() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <Navigate to="/guides" replace />;
  return <GuidePage slug={slug} />;
}

const allCommands = getAllCommands();
const allCategories = getAllCategories();
const allSkills = {
  claude: getInventory('v1').claude_skills,
  codex: getInventory('v1').codex_skills,
};

function VersionAwareRoutes() {
  const { version } = useVersion();
  const inv = getInventory(version);

  return (
    <Switch>
      <Route path="/"><LandingPage categories={inv.categories} /></Route>

      {allCategories.map((category) => (
        <Route key={category.id} path={`/${category.id}`}>
          <CategoryPage
            categoryId={category.id}
            category={inv.categories.find((c) => c.id === category.id) || category}
            commands={inv.commands.filter((c) => c.category === category.id)}
            claudeSkills={inv.claude_skills.filter((s) => s.category === category.id)}
            codexSkills={inv.codex_skills.filter((s) => s.category === category.id)}
          />
        </Route>
      ))}

      {allCommands.map((command) => {
        const slug = getCommandSlug(command.name);
        const cat = allCategories.find((c) => c.id === command.category);
        if (!cat) return null;
        return (
          <Route key={command.name} path={`/${command.category}/${slug}`}>
            <CommandDetailPage commandName={command.name} category={cat} command={command} />
          </Route>
        );
      })}

      {allSkills.claude.map((skill) => (
        <Route key={`claude-${skill.name}`} path={`/skills/${skill.name}`}>
          <SkillDetailPage
            skillName={skill.name}
            skillType="claude"
            skill={skill}
            category={allCategories.find((c) => c.id === skill.category)!}
          />
        </Route>
      ))}

      {allSkills.codex.map((skill) => (
        <Route key={`codex-${skill.name}`} path={`/codex/${skill.name}`}>
          <SkillDetailPage
            skillName={skill.name}
            skillType="codex"
            skill={skill}
            category={allCategories.find((c) => c.id === skill.category)!}
          />
        </Route>
      ))}

      <Route path="/search"><SearchPage /></Route>
      <Route path="/changelog"><ChangelogPage /></Route>
      <Route path="/quick-start"><QuickStartPage /></Route>
      <Route path="/guides"><Navigate to="/guides/command-usage" replace /></Route>
      <Route path="/guides/:slug"><GuideRouteWrapper /></Route>
      <Route><Navigate to="/" replace /></Route>
    </Switch>
  );
}

export function App() {
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || undefined;

  return (
    <I18nProvider>
      <VersionProvider>
        <BrowserRouter basename={basename}>
          <Layout>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue" />
                </div>
              }
            >
              <VersionAwareRoutes />
            </Suspense>
          </Layout>
        </BrowserRouter>
      </VersionProvider>
    </I18nProvider>
  );
}
