import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import TopToolbar from '@/components/TopToolbar';
import LeftSidebar from '@/components/LeftSidebar';
import Viewport3D from '@/components/Viewport3D';
import HUDOverlay from '@/components/HUDOverlay';
import StatusBar from '@/components/StatusBar';
import ReportView from '@/components/ReportView';
import { lazy, Suspense } from 'react';
import type { CadProjectData } from '@/components/CadView';
import type { CadBuildingShape, CadPanelRect } from '@/lib/cadEngine';
// CAD page (canvas engine + jspdf + parametric engine) is code-split out of
// the main bundle and lazy-loaded only when the user opens the CAD view.
const CadView = lazy(() => import('@/components/CadView'));
import {
  DEFAULT_CONFIG, PANEL_DB, PANEL_OPTIONS, getSunPosition, computeLayout,
  generateFullReportHTML, buildProjectData, autoLayoutPanelCount,
  createArrayConfig, computeBoundaryFit, INVERTER_DB, computeStringSizing,
  registerLibraryPanels,
   SystemType,

  computeCable, computeROI, getProfileSize,
  createVariant, cloneArrays, normalizeVariant,
  DEFAULT_STRING_T_MIN, DEFAULT_STRING_T_MAX,
  type StructureConfig, type PolygonData, type ArrayConfig, type ProjectVariant, type StringDesignInput,
} from '@/lib/solar';
import { DEFAULT_FINANCIALS, type FinancialProfile } from '@/lib/financialProfile';
import { resolveUnitSystem, UNIT_PREF_KEY, type UnitSystem } from '@/lib/units';
import { WIND_REGIONS, getRegionForCountry } from '@/lib/structuralMath';
import type { ViewMode, TransformMode, SolarSceneManager, OutlinerEntry } from '@/lib/scene';
import { isOrthoViewMode } from '@/lib/scene';
import { supabase, fetchProfile, decrementCredit, type UserProfile } from '@/lib/auth';
import AuthModal from '@/components/AuthModal';
import ImportExportModal from '@/components/ImportExportModal';
import { importModelFile, exportSceneAs, type ExportFormat } from '@/lib/importExport';
import { WelcomeModal, TourOverlay, TOUR_STEPS, useTour } from '@/components/WelcomeModal';
import ProjectView from '@/components/ProjectView';
import { importGeoJSON } from '@/lib/projectHelpers';
import EquipmentLibraryModal from '@/components/EquipmentLibraryModal';
import VariantsModal from '@/components/VariantsModal';
import ShortcutsModal from '@/components/ShortcutsModal';
import EditToolbar from '@/components/EditToolbar';
import {
  loadLibrary, saveLibrary, resetLibrary, buildBoM, bomToCSV, bomTableHTML,
  type EquipmentLibrary,
} from '@/lib/equipmentLibrary';
import { useKeyboardShortcuts } from '@/lib/shortcuts';
import L from 'leaflet';
// NEW: Structural Design Engine
import { StructuralDesignEngine } from '@/components/StructureControlPanel';
import { Mountain, X } from 'lucide-react';

// Compute 4-corner panel overlay polygons rotated as a whole array around building center
function computePanelOverlayRects(
  config: StructureConfig,
  polygons: PolygonData[],
): [number, number][][] {
  const active = polygons.filter(p => p.placePanels);
  if (active.length === 0) return [];

  const panelData = PANEL_DB[config.panelId] || PANEL_OPTIONS[0];
  const rows = config.rows;
  const cols = config.cols;
  const azimuthDeg = config.azimuth;
  const isLandscape = config.isLandscape;
  const arrayRows = config.arrayRows;
  const arrayCols = config.arrayCols;
  const gapX = config.panelSpacingX;
  const gapY = config.panelSpacingY;

  let pw = panelData.w,
    ph = panelData.h;
  if (isLandscape) { pw = panelData.h; ph = panelData.w; }

  const pitchX = pw + gapX;
  const pitchY = ph + gapY;
  const blockWidth = cols * pw + (cols - 1) * gapX;
  const blockHeight = rows * ph + (rows - 1) * gapY;
  const totalWidth = arrayCols * blockWidth + (arrayCols - 1) * config.arraySpacingX;
  const totalHeight = arrayRows * blockHeight + (arrayRows - 1) * config.arraySpacingY;

  const azRad = azimuthDeg * Math.PI / 180;
  const cosA = Math.cos(azRad);
  const sinA = Math.sin(azRad);

  const panelPolygons: [number, number][][] = [];

  active.forEach(poly => {
    if (!poly.latlngs || poly.latlngs.length < 3) return;

    const sumLat = poly.latlngs.reduce((acc, curr) => acc + curr[0], 0);
    const sumLng = poly.latlngs.reduce((acc, curr) => acc + curr[1], 0);
    const centerLat = (poly as any).centerLat ?? (sumLat / poly.latlngs.length);
    const centerLng = (poly as any).centerLng ?? (sumLng / poly.latlngs.length);

    const mPerDegLng = 111320 * Math.cos(centerLat * Math.PI / 180);
    const mPerDegLat = 111320;

    const latlngs = poly.latlngs.map(ll => L.latLng(ll[0], ll[1]));
    const bounds = L.latLngBounds(latlngs);

    let polyW = poly.width;
    let polyH = poly.height;
    if (!polyW || !polyH || polyW === 0 || polyH === 0) {
      polyW = (bounds.getEast() - bounds.getWest()) * mPerDegLng;
      polyH = (bounds.getNorth() - bounds.getSouth()) * mPerDegLat;
    }

    const fit = computeBoundaryFit(config, { width: polyW, height: polyH });
    const scale = config.fitToBoundary ? fit.scale : 1;

    const fw = totalWidth * scale;
    const fh = totalHeight * scale;
    const arrayCenterX = fw / 2;
    const arrayCenterY = fh / 2;

    for (let ar = 0; ar < arrayRows; ar++) {
      for (let ac = 0; ac < arrayCols; ac++) {
        const bx = ac * (blockWidth * scale + config.arraySpacingX * scale);
        const bz = ar * (blockHeight * scale + config.arraySpacingY * scale);

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const minX = bx + c * (pitchX * scale);
            const maxX = minX + (pw * scale);
            const minY = bz + r * (pitchY * scale);
            const maxY = minY + (ph * scale);

            // Local coordinates: x = east, y = north
            const localCorners = [
              { x: minX - arrayCenterX, y: minY - arrayCenterY },
              { x: maxX - arrayCenterX, y: minY - arrayCenterY },
              { x: maxX - arrayCenterX, y: maxY - arrayCenterY },
              { x: minX - arrayCenterX, y: maxY - arrayCenterY }
            ];

            const rotatedCorners = localCorners.map(pt => {
              // Rotate around origin by azimuth (clockwise from north)
              const rotX = pt.x * cosA - pt.y * sinA;
              const rotY = pt.x * sinA + pt.y * cosA;
              // Map to lat/lng: east = +X, north = +Y
              const lat = centerLat + rotY / mPerDegLat;
              const lng = centerLng + rotX / mPerDegLng;
              return [lat, lng] as [number, number];
            });

            panelPolygons.push(rotatedCorners);
          }
        }
      }
    }
  });

  return panelPolygons;
}

// ---- CAD traced geometry ----------------------------------------------------
// Converts traced map polygons + the panel layout into a shared millimetre
// site frame (y-down) for the CAD drawing sheets. Mirrors the fit/rotation
// math of computePanelOverlayRects exactly so C-101/A-101 render the same
// buildings and module positions the user sees in the map and 3D views.
function computeCadTracedGeometry(
  config: StructureConfig,
  polygons: PolygonData[],
): { buildings: CadBuildingShape[]; panels: CadPanelRect[]; panelWMm: number; panelHMm: number } {
  const panelData = PANEL_DB[config.panelId] || PANEL_OPTIONS[0];
  let pw = panelData.w;
  let ph = panelData.h;
  if (config.isLandscape) { pw = panelData.h; ph = panelData.w; }

  const buildings: CadBuildingShape[] = [];
  const panels: CadPanelRect[] = [];
  const traced = { buildings, panels, panelWMm: Math.round(pw * 1000), panelHMm: Math.round(ph * 1000) };
  if (polygons.length === 0) return traced;

  // Per-building frames + site-frame origin (global bbox min corner: minLng, maxLat).
  let minLng = Infinity;
  let maxLat = -Infinity;
  const frames = polygons.map((poly) => {
    const lls = poly.latlngs;
    const withCenter = poly as unknown as { centerLat?: number; centerLng?: number };
    const centerLat = withCenter.centerLat ?? lls.reduce((a, c) => a + c[0], 0) / lls.length;
    const centerLng = withCenter.centerLng ?? lls.reduce((a, c) => a + c[1], 0) / lls.length;
    for (const [la, ln] of lls) {
      if (ln < minLng) minLng = ln;
      if (la > maxLat) maxLat = la;
    }
    const mPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
    let polyW = poly.width;
    let polyH = poly.height;
    if (!polyW || !polyH || polyW === 0 || polyH === 0) {
      const lats = lls.map((l) => l[0]);
      const lngs = lls.map((l) => l[1]);
      polyW = (Math.max(...lngs) - Math.min(...lngs)) * mPerDegLng;
      polyH = (Math.max(...lats) - Math.min(...lats)) * 111320;
    }
    return { poly, centerLat, centerLng, mPerDegLng, polyW, polyH };
  });
  if (!isFinite(minLng)) return traced;

  // Building outlines in the shared site frame (mm).
  for (const f of frames) {
    if (f.poly.latlngs.length < 3) continue;
    buildings.push({
      id: f.poly.id,
      name: f.poly.name ?? `Building ${f.poly.id}`,
      wMm: Math.round(f.polyW * 1000),
      hMm: Math.round(f.polyH * 1000),
      boundaryMm: f.poly.latlngs.map(([la, ln]) => ({
        x: (ln - minLng) * f.mPerDegLng * 1000,
        y: (maxLat - la) * 111320 * 1000,
      })),
      placePanels: f.poly.placePanels,
    });
  }

  // Panel rects (mirror computePanelOverlayRects layout; azimuth rotation is
  // applied once — at render time — about rotPivot, so positions stay unrotated).
  const rows = config.rows;
  const cols = config.cols;
  const gapX = config.panelSpacingX;
  const gapY = config.panelSpacingY;
  const pitchX = pw + gapX;
  const pitchY = ph + gapY;
  const blockWidth = cols * pw + (cols - 1) * gapX;
  const blockHeight = rows * ph + (rows - 1) * gapY;
  const totalWidth = config.arrayCols * blockWidth + (config.arrayCols - 1) * config.arraySpacingX;
  const totalHeight = config.arrayRows * blockHeight + (config.arrayRows - 1) * config.arraySpacingY;

  for (const f of frames) {
    if (!f.poly.placePanels || f.poly.latlngs.length < 3) continue;
    const fit = computeBoundaryFit(config, { width: f.polyW, height: f.polyH });
    const scale = config.fitToBoundary ? fit.scale : 1;
    const fw = totalWidth * scale;
    const fh = totalHeight * scale;

    // Array rotation pivot in site-frame mm.
    const pivotX = (f.centerLng - minLng) * f.mPerDegLng * 1000;
    const pivotY = (maxLat - f.centerLat) * 111320 * 1000;

    for (let ar = 0; ar < config.arrayRows; ar++) {
      for (let ac = 0; ac < config.arrayCols; ac++) {
        const bx = ac * (blockWidth * scale + config.arraySpacingX * scale);
        const bz = ar * (blockHeight * scale + config.arraySpacingY * scale);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const minX = bx + c * (pitchX * scale);
            const minY = bz + r * (pitchY * scale);
            // Unrotated panel centre relative to the array centre (metres).
            const lcx = minX + (pw * scale) / 2 - fw / 2;
            const lcy = minY + (ph * scale) / 2 - fh / 2;
            // Unrotated site-frame millimetre position. The azimuth rotation
            // is applied by the CAD renderer about (rotPivot) — exactly once.
            const cx = pivotX + lcx * 1000;
            const cy = pivotY + lcy * 1000;
            const w = pw * scale * 1000;
            const h = ph * scale * 1000;
            panels.push({
              bId: f.poly.id,
              x: cx - w / 2,
              y: cy - h / 2,
              w,
              h,
              rotDeg: config.azimuth,
              rotPivot: { x: pivotX, y: pivotY },
            });
          }
        }
      }
    }
  }

  return traced;
}

let polygonIdCounter = 0;

export default function App() {
  const [arrays, setArrays] = useState<ArrayConfig[]>([
    createArrayConfig('array-1', 'Array 1', { azimuth: 180 }),
  ]);
  const [activeArrayId, setActiveArrayId] = useState('array-1');
  const activeArray = arrays.find((a) => a.id === activeArrayId) || arrays[0];
  const config = useMemo(
    () => (activeArray ? { ...DEFAULT_CONFIG, ...activeArray.config } : DEFAULT_CONFIG),
    [activeArray],
  );
  const setConfig = useCallback((c: StructureConfig) => {
  setArrays((prev) => prev.map((a) => a.id === activeArrayId ? { ...a, config: { ...DEFAULT_CONFIG, ...c } } : a));
}, [activeArrayId]);
  const handleLocationChange = useCallback((newLat: number, newLng: number) => {
    setLat(newLat);
    setLng(newLng);
    setConfig({ ...config, azimuth: newLat >= 0 ? 180 : 0 });
  }, [config, setConfig]);
  const [lat, setLat] = useState(34.1202);
  const [lng, setLng] = useState(72.4700);
  const [polygons, setPolygons] = useState<PolygonData[]>([]);
  const [selectedPolygonId, setSelectedPolygonId] = useState<number | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('perspective');
  const [wireframe, setWireframe] = useState(false);
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [showShadows, setShowShadows] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [snapGrid, setSnapGrid] = useState(true);
  const [snapMesh, setSnapMesh] = useState(false);
  const [groundTexture, setGroundTexture] = useState<THREE.Texture | null>(null);
  const [groundSize, setGroundSize] = useState<[number, number]>([100, 100]);
  const [buildingHeight, setBuildingHeight] = useState(3.0);
  const [siteCenter, setSiteCenter] = useState<{ lat: number; lng: number } | null>(null);

  const [sunDate, setSunDate] = useState(new Date().toISOString().split('T')[0]);
  const [sunTime, setSunTime] = useState(12);

  const [statusMsg, setStatusMsg] = useState('SolarMount Pro v2.2 — Ready');
  const [boundaryWarning, setBoundaryWarning] = useState<string | null>(null);
  const [isAllSelected, setIsAllSelected] = useState(false);
  const [generateTrigger, setGenerateTrigger] = useState(0);
  const [panelOverlayRects, setPanelOverlayRects] = useState<[number, number][][] | null>(null);
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(() =>
    resolveUnitSystem(localStorage.getItem(UNIT_PREF_KEY))
  );
  const handleSetUnitSystem = useCallback((u: UnitSystem) => {
    setUnitSystem(u);
    try { localStorage.setItem(UNIT_PREF_KEY, u); } catch { /* storage unavailable */ }
  }, []);
  const [view, setView] = useState<'project' | '3d' | 'report' | 'cad'>('project');
  const managerRef = useRef<SolarSceneManager | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const { showWelcome, showTour, startTour, skipWelcome, endTour, reopenWelcome } = useTour();

  // NEW: Structural Design Engine modal state
  const [showStructuralDesign, setShowStructuralDesign] = useState(false);

  // Dimension tool state
  const [dimensionMode, setDimensionMode] = useState(false);
  const [dimensionDistance, setDimensionDistance] = useState<number | null>(null);
  const [dimensionPrompt, setDimensionPrompt] = useState(false);
  const [dimensionInput, setDimensionInput] = useState('');
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [solarLocked, setSolarLocked] = useState(false);
  const [outlinerEntries, setOutlinerEntries] = useState<OutlinerEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [outlinerRefresh, setOutlinerRefresh] = useState(0);
  const [selectedSceneType, setSelectedSceneType] = useState<string | null>(null);
  const [selectedPos, setSelectedPos] = useState<{ x: number; y: number; z: number } | null>(null);

  // Report fields
  const [inverterId, setInverterId] = useState(INVERTER_DB[0]?.id || '');
   const [inverterCount, setInverterCount] = useState(1);
   const [mpptMode, setMpptMode] = useState<'single' | 'multi'>('multi');
   const [systemType, setSystemType] = useState<SystemType>('on-grid');
  const [companyName, setCompanyName] = useState('My Solar Company');
  const [companyAddress, setCompanyAddress] = useState('123 Solar Street, City, Country');
  const [companyPhone, setCompanyPhone] = useState('+1 234 567 8900');
  const [companyEmail, setCompanyEmail] = useState('info@mysolar.com');
    const [batteryId, setBatteryId] = useState<string>('');
  const [batteryQty, setBatteryQty] = useState(1);
    const [projectName, setProjectName] = useState('Solar Project');
  const [financials, setFinancials] = useState<FinancialProfile>(DEFAULT_FINANCIALS);

  // Client / site details for report
  const [clientName, setClientName] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [siteAddress, setSiteAddress] = useState('42 Sunshine Road, Brunswick VIC 3056');
  const [quoteNumber, setQuoteNumber] = useState('SP-2026-1842');
  const [quoteDate, setQuoteDate] = useState(new Date().toISOString().split('T')[0]);

  // ── Project variants — multiple system configurations per project ──
  // (like PVsyst "calculation versions"), each holding its own arrays + electrical picks.
  const [variants, setVariants] = useState<ProjectVariant[]>(() => [createVariant('variant-1', 'Variant 1')]);
  const [activeVariantId, setActiveVariantId] = useState('variant-1');

  // ── Live string-design inputs (Phase 4: persisted per variant) ──
  // 0 = auto-suggest from the inverter MPPT window; design temps drive the
  // temperature-corrected Voc/Vmp bounds. Synced from the active variant on
  // load / switch so each variant remembers its own electrical design.
  const [stringDesign, setStringDesign] = useState<StringDesignInput>(() => ({
    modulesPerString: 0,
    parallelStrings: 0,
    tMinC: DEFAULT_STRING_T_MIN,
    tMaxC: DEFAULT_STRING_T_MAX,
  }));
  useEffect(() => {
    const v = variants.find((x) => x.id === activeVariantId);
    if (v?.stringDesign) setStringDesign(v.stringDesign);
  }, [activeVariantId, variants]);

  // ------------------------------------------------------------
  // FIX: equipment library must be defined BEFORE any code reads it
  // ------------------------------------------------------------
  const [library, setLibrary] = useState<EquipmentLibrary>(() => loadLibrary());

  // Derived from library – reactive to changes
  const cableModels = useMemo(() => library.cables || [], [library]);
  const [cableId, setCableId] = useState(() => cableModels.length > 0 ? cableModels[0].id : '');
  const [shadingProvider, setShadingProvider] = useState<'pvgis' | 'meteonorm' | 'nrel' | 'manual'>('pvgis');

  // Keep cableId in sync when library changes
  useEffect(() => {
    if (cableModels.length > 0 && !cableModels.some(c => c.id === cableId)) {
      setCableId(cableModels[0].id);
    } else if (cableModels.length === 0) {
      setCableId('');
    }
  }, [cableModels, cableId]);

  // Register library panels into PANEL_DB so geometry/energy calculations use
  // the exact selected module, and keep every array's panelId valid.
  const panelSyncRef = useRef(config);
  panelSyncRef.current = config;
  useEffect(() => {
    registerLibraryPanels(library.panels);
    const panels = library.panels || [];
    if (panels.length > 0 && !panels.some(p => p.id === panelSyncRef.current.panelId)) {
      const firstId = panels[0].id;
      setArrays(prev => prev.map(a => ({ ...a, config: { ...a.config, panelId: firstId } })));
    }
  }, [library]);

  // ------------------------------------------------------------
  // End of library fix
  // ------------------------------------------------------------

  // Equipment library modal state
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [variantsOpen, setVariantsOpen] = useState(false);

  // NEW: Handle opening the Structural Design Engine
  const handleOpenStructuralDesign = useCallback(() => {
    setShowStructuralDesign(true);
  }, []);

  const sunPos = useMemo(() => {
    const d = new Date(sunDate + 'T00:00:00');
    d.setHours(Math.floor(sunTime), Math.round((sunTime % 1) * 60), 0, 0);
    return getSunPosition(d, lat, lng);
  }, [sunDate, sunTime, lat, lng]);

  const activePolygons = useMemo(() => {
    const active = polygons.filter((p) => p.placePanels).map((p) => ({ id: p.id, width: p.width, height: p.height, placePanels: p.placePanels }));
    if (active.length > 0) return active;
    return [{ id: 0, width: 30, height: 20, placePanels: true }];
  }, [polygons]);
  const layout = useMemo(() => computeLayout(arrays, activePolygons), [arrays, activePolygons]);

  // ---- Report page feed — library panels keyed by id so the report resolves
  // the exact selected module (same record shape as PANEL_DB). ----
  const libraryPanelsById = useMemo(() => {
    const rec: Record<string, (typeof library.panels)[number]> = {};
    for (const p of library.panels) rec[p.id] = p;
    return rec;
  }, [library.panels]);

  // ---- CAD page feed — accurate values pulled from the current project design ----
  const cadData = useMemo<CadProjectData>(() => {
    const poly = activePolygons[0];
    const tracedCad = computeCadTracedGeometry(config, polygons);
    const panel = PANEL_DB[config.panelId];
    const sr = computeStringSizing(config, layout.totalPanels, inverterId);
    const inv = sr?.inverterModel ?? INVERTER_DB.find((i) => i.id === inverterId) ?? null;
    const fuseA = sr ? Math.ceil((sr.current * 1.25) / 5) * 5 : 25;
    const invKw = inv?.maxPower ?? layout.totalKw ?? 5;
    const acA = Math.max(10, Math.ceil(((invKw * 1000) / (230 * 1.25)) / 5) * 5);
    const dcCableRes = sr ? computeCable(sr.current, 35, 1.5, sr.voltage) : null;
    const acCableRes = computeCable(Math.max(10, (invKw * 1000) / 400), 18, 2, 400);
    const bat = batteryId ? library.batteries.find((b) => b.id === batteryId) : null;
    return {
      projectTitle: projectName || 'Solar PV Installation',
      client: clientName || '—',
      siteAddr: siteAddress || '—',
      drawnBy: companyName || 'SolarMount CAD',
      capacityKw: Number(layout.totalKw.toFixed(2)),
      roofWmm: poly ? Math.round(poly.width * 1000) : 16000,
      roofHmm: poly ? Math.round(poly.height * 1000) : 10000,
      parapetHmm:
        (config.boundaryWallHeight || 0) > 0 ? Math.round(config.boundaryWallHeight * 1000) : 900,
      // Walkway/fire-access clearance = boundary wall height × inset factor (m → mm).
      walkwayWmm:
        (config.boundaryWallHeight || 0) > 0
          ? Math.round(config.boundaryWallHeight * (config.boundaryInsetFactor || 1.5) * 1000)
          : 1200,
      rows: Math.max(1, config.rows * config.arrayRows),
      cols: Math.max(1, config.cols * config.arrayCols),
      mountType:
        config.structureType === 'ELEVATED'
          ? 'Ground Mount Fixed Leg'
          : config.concreteBlock
            ? 'Ballasted Flat Roof'
            : 'Roof Standard Rail',
      railProfile: `${getProfileSize(config.profileType, config.profileSizeIndex).label} ${config.materialFinish === 'GALVANIZED' ? 'Galvanized' : 'Anodized'} Rail`,
      postProfile:
        config.structureType === 'ELEVATED'
          ? `Leg Height ${config.minFrontHeight.toFixed(2)}m–${config.elevatedHeight.toFixed(2)}m Galvanized Steel`
          : 'Hot-Dip Galvanized C-Channel 80x40mm',
      tiltDeg: config.tilt,
      postSpacingMm: Math.round(config.arraySpacingX * 1000) || 1400,
      padDim: config.concreteBlock
        ? `${config.concreteBlockSize} Concrete Ballast Block`
        : '400x400x600mm Concrete Footing',
       sysType: systemType === 'on-grid' ? 'ongrid' : systemType === 'off-grid' ? 'offgrid' : systemType === 'hybrid' ? 'hybrid' : 'pumping',
      pvStringSpec: sr
        ? `${sr.strings} Strings x ${sr.panelsPerString} Modules (${panel?.name ?? 'PV Module'})`
        : 'Set strings in Design settings',
      invModel: inv ? `${inv.name} · ${inv.maxPower}kW · ${inv.numMPPT}x MPPT` : 'Inverter',
      batSpec: bat
        ? `${bat.name} · ${bat.usableKwh}kWh Usable ${bat.chemistry ?? 'LiFePO4'}`
        : systemType === 'on-grid'
          ? 'N/A — Grid-Tied (No Storage)'
          : '48V LiFePO4 Battery Bank',
      dcProtSpec: sr
        ? `${Math.round(sr.maxVoltage)}V DC ${fuseA}A Fuses | Class II DC SPD 40kA`
        : '1000V DC 25A Fuses | Class II DC SPD 40kA',
      dcIsoSpec: sr
        ? `${Math.round(sr.maxVoltage)}V DC ${fuseA}A 4-Pole Rotary Isolator`
        : '1000V DC 32A 4-Pole Rotary Isolator',
      acProtSpec: `${acA}A 4-Pole 10kA MCB | Class II AC SPD 40kA`,
      dcCable: dcCableRes
        ? `${dcCableRes.cable.name} Solar PV Cable (Run: 35m)`
        : '6mm² Solar PV Cable (Run: 35m)',
      acCable: acCableRes
        ? `${acCableRes.cable.name} AC Feeder (Run: 18m)`
        : '4-Core 16mm² Armored Cable (Run: 18m)',
      pumpSpec: '10 HP 3-Phase Submersible Pump',
      structureType: config.structureType,
      azimuthDeg: Math.round(config.azimuth),
      buildings: tracedCad.buildings,
      panels: tracedCad.panels,
      panelWMm: tracedCad.panelWMm,
      panelHMm: tracedCad.panelHMm,
      panelLengthMm: Math.round((config.isLandscape ? (panel?.w ?? 1.134) : (panel?.h ?? 2.278)) * 1000),
      frontClearanceMm:
        config.structureType === 'ELEVATED'
          ? Math.round((config.elevatedHeight ?? 1.0) * 1000)
          : Math.max(300, Math.round((config.minFrontHeight ?? 0.3) * 1000)),
    };
  }, [activePolygons, config, layout, inverterId, systemType, batteryId, library, projectName, clientName, siteAddress, companyName, polygons]);


  useEffect(() => {
    const rects = computePanelOverlayRects(config, polygons);
    setPanelOverlayRects(rects);
  }, [config, polygons]);

  useEffect(() => {
    const active = polygons.filter((p) => p.placePanels);
    if (active.length === 0) { setBoundaryWarning(null); return; }
    const msgs: string[] = [];
    for (const p of active) {
      const fit = computeBoundaryFit(config, p);
      if (fit.roofTooSmall) {
        msgs.push(`Building ${p.id}: roof too small for shading inset.`);
      } else if (fit.clipped) {
        msgs.push(`Building ${p.id}: array clipped — auto-fitted to ${(fit.scale * 100).toFixed(0)}%.`);
      }
    }
    setBoundaryWarning(msgs.length > 0 ? msgs.join('  ·  ') : null);
  }, [config, polygons]);

  const handlePolygonCreated = useCallback((latlngs: [number, number][], type: 'rectangle' | 'polygon', width: number, height: number) => {
    const id = ++polygonIdCounter;
    const latLngs = latlngs.map(ll => L.latLng(ll[0], ll[1]));
    const bounds = L.latLngBounds(latLngs);
    const sumLat = latlngs.reduce((acc, curr) => acc + curr[0], 0);
    const sumLng = latlngs.reduce((acc, curr) => acc + curr[1], 0);
    const centerLat = sumLat / latlngs.length;
    const centerLng = sumLng / latlngs.length;

    if (width === 0 || height === 0) {
      const mPerDegLng = 111320 * Math.cos(centerLat * Math.PI / 180);
      const mPerDegLat = 111320;
      width = Math.max((bounds.getEast() - bounds.getWest()) * mPerDegLng, 1);
      height = Math.max((bounds.getNorth() - bounds.getSouth()) * mPerDegLat, 1);
    }

    const newPoly: PolygonData = {
      id,
      type,
      latlngs,
      bounds,
      width,
      height,
      placePanels: true,
      extruded: false,
      ...( { centerLat, centerLng, offsetX: 0, offsetY: 0 } as any )
    };
    setPolygons((prev) => [...prev, newPoly]);
    setSelectedPolygonId(id);
    setStatusMsg(`${type}: ${width.toFixed(1)}x${height.toFixed(1)}m`);
  }, []);

  const handleTogglePanels = useCallback((id: number) => {
    setPolygons((prev) => prev.map((p) => p.id === id ? { ...p, placePanels: !p.placePanels } : p));
  }, []);

  const handleDeletePolygon = useCallback((id: number) => {
    setPolygons((prev) => prev.filter((p) => p.id !== id));
    if (selectedPolygonId === id) setSelectedPolygonId(null);
  }, [selectedPolygonId]);

  const handleDeleteAll = useCallback(() => {
    setPolygons([]);
    setSelectedPolygonId(null);
    setStatusMsg('All buildings deleted.');
  }, []);

  const handleAutoLayout = useCallback(() => {
    const active = polygons.filter((p) => p.placePanels);
    if (active.length === 0) { setStatusMsg('No buildings with panels enabled.'); return; }
    const p = active[0];
    const { rows, cols } = autoLayoutPanelCount(config, p);
    setConfig({ ...config, rows, cols, arrayRows: 1, arrayCols: 1 });
    setStatusMsg(`Auto-layout: ${cols}x${rows} panels`);
  }, [polygons, config, setConfig]);

  const handleExtrude = useCallback(() => {
    if (selectedPolygonId === null) { setStatusMsg('No building selected.'); return; }
    const p = polygons.find((x) => x.id === selectedPolygonId);
    if (!p) return;
    if (p.extruded) {
      setPolygons((prev) => prev.map((x) => x.id === selectedPolygonId ? { ...x, extruded: false } : x));
      if (typeof (managerRef.current as any)?.removeBuilding === 'function') {
        (managerRef.current as any).removeBuilding(selectedPolygonId);
      }
      setStatusMsg(`Building #${selectedPolygonId} extrusion removed.`);
    } else {
      setPolygons((prev) => prev.map((x) => x.id === selectedPolygonId ? { ...x, extruded: true } : x));
      setStatusMsg(`Building #${selectedPolygonId} extruded to ${buildingHeight.toFixed(1)}m`);
    }
  }, [selectedPolygonId, polygons, buildingHeight]);

  useEffect(() => {
    const manager = managerRef.current as any;
    if (!manager) return;
    const ref = siteCenter ?? { lat, lng };
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(ref.lat * Math.PI / 180);
    const extrudedIds = new Set<number>();
    for (const p of polygons) {
      if (!p.extruded || !p.latlngs || p.latlngs.length < 3) continue;
      extrudedIds.add(p.id);
    }
    // Scene manager may not implement building APIs yet — never throw
    if (typeof manager.removeBuildingsExcept === 'function') {
      try { manager.removeBuildingsExcept(extrudedIds); } catch (e) { console.warn(e); }
    }
    if (typeof manager.extrudeBuilding !== 'function') return;
    for (const p of polygons) {
      if (!p.extruded || !p.latlngs || p.latlngs.length < 3) continue;
      try {
        manager.extrudeBuilding(p.id, p.latlngs, ref.lat, ref.lng, mPerDegLng, mPerDegLat, buildingHeight);
      } catch (e) {
        console.warn('[extrudeBuilding]', e);
      }
    }
  }, [polygons, buildingHeight, generateTrigger, siteCenter, lat, lng]);

  const solarAnchor = useMemo(() => {
    const target = polygons.find((p) => p.id === selectedPolygonId && p.extruded && p.latlngs && p.latlngs.length >= 3)
      ?? polygons.find((p) => p.extruded && p.latlngs && p.latlngs.length >= 3);
    if (!target) return null;
    const ref = siteCenter ?? { lat, lng };
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(ref.lat * Math.PI / 180);
    const sumLat = target.latlngs.reduce((a, c) => a + c[0], 0);
    const sumLng = target.latlngs.reduce((a, c) => a + c[1], 0);
    const clat = sumLat / target.latlngs.length;
    const clng = sumLng / target.latlngs.length;
    return {
      x: (clng - ref.lng) * mPerDegLng,  // east positive
      z: -(clat - ref.lat) * mPerDegLat, // north negative
      height: buildingHeight,
    };
  }, [polygons, selectedPolygonId, siteCenter, lat, lng, buildingHeight]);

  const handleSearch = useCallback(async (query: string) => {
    if (!query) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (data && data.length > 0) {
        const la = parseFloat(data[0].lat);
        const ln = parseFloat(data[0].lon);
        setLat(la);
        setLng(ln);
        setStatusMsg(`Found: ${la.toFixed(4)}, ${ln.toFixed(4)}`);
      } else setStatusMsg('Location not found.');
    } catch { setStatusMsg('Error searching.'); }
  }, []);

  const handleObjectSelect = useCallback((obj: THREE.Object3D | null) => {
    setIsAllSelected(obj !== null && obj.type === 'Group' && obj.children.length > 1);
    setSelectedSceneType(obj !== null ? (obj.userData?.type as string | undefined) ?? null : null);
    if (obj) {
      setSelectedEntryId(obj.userData?.id || obj.uuid);
      const m = managerRef.current;
      const p = m?.getSelectedPosition?.();
      setSelectedPos(p ? { x: p.x, y: p.y, z: p.z } : null);
    } else {
      setSelectedEntryId(null);
      setSelectedPos(null);
    }
    setOutlinerRefresh((n) => n + 1);
  }, []);

  const handleSetTransform = useCallback((mode: TransformMode) => setTransformMode(mode), []);
  const handleDuplicate = useCallback(() => {
    const m = managerRef.current;
    const selected = m?.selectedObject ?? null;
    const selType = selected?.userData?.type as string | undefined;
    // Buildings & imported models: clone the 3D object in place — the manager
    // tracks the clone and it survives regenerations.
    if (selType === 'building' || selType === 'imported') {
      const clone = m?.duplicateSelected();
      setStatusMsg(clone ? 'Object duplicated.' : 'Duplicate failed.');
      return;
    }
    // Solar arrays: duplicate the CONFIG, never the mesh. A raw mesh clone is
    // untracked by generateStructure and becomes a permanent ghost that
    // desyncs the HUD/BOM panel counts from what's rendered.
    const sourceId = (selected?.userData?.arrayId as string | undefined) ?? activeArrayId;
    const baseArray = arrays.find((a) => a.id === sourceId) || arrays[0];
    if (!baseArray) { setStatusMsg('Nothing to duplicate.'); return; }
    const newId = `array-${Date.now()}`;
    const newArray = createArrayConfig(newId, `${baseArray.name} (copy)`, { ...baseArray.config });
    // Offset the copy so it doesn't overlap the original; locked so the
    // offset survives every regeneration.
    newArray.position = { x: baseArray.position.x + 2.5, z: baseArray.position.z + 2.5 };
    newArray.locked = true;
    setArrays((prev) => [...prev, newArray]);
    setActiveArrayId(newId);
    setStatusMsg(`Array duplicated: ${newArray.name}`);
  }, [arrays, activeArrayId]);

  const handleDelete = useCallback(() => { managerRef.current?.deleteSelected(); setStatusMsg('Deleted.'); }, []);

  const handleSelectAll = useCallback(() => {
    managerRef.current?.selectAllArrays();
    setIsAllSelected(true);
    setStatusMsg('All solar panel arrays selected.');
  }, []);

  const handleMoveAll = useCallback(() => {
    managerRef.current?.selectAllArrays();
    setTransformMode('translate');
    setIsAllSelected(true);
    setStatusMsg('Move mode activated for all panel arrays.');
  }, []);

  const handleFrameAll = useCallback(() => { managerRef.current?.fitToExtents(); setStatusMsg('Fit to extents.'); }, []);

  const handleCenterPivot = useCallback(() => {
    managerRef.current?.centerPivotSelected();
    setStatusMsg('Pivot set to bottom-center of selection.');
  }, []);

  const handleZoomToSelected = useCallback(() => {
    managerRef.current?.zoomToSelected();
    setStatusMsg('Zoomed to selected object.');
  }, []);

  const handleSetSelectedPosition = useCallback((x: number, y: number, z: number) => {
    managerRef.current?.setPosition(x, y, z);
    setSelectedPos({ x, y, z });
    setStatusMsg('Object position updated.');
  }, []);

  const handleMoveSelected = useCallback((dx: number, dy: number, dz: number) => {
    const m = managerRef.current;
    if (!m) return;
    m.moveSelected(dx, dy, dz);
    const p = m.getSelectedPosition();
    if (p) setSelectedPos({ x: p.x, y: p.y, z: p.z });
    setStatusMsg('Object moved.');
  }, []);

  const handleToggleOrtho = useCallback(() => {
    setViewMode((v) => (isOrthoViewMode(v) ? 'perspective' : 'ortho-front'));
    setStatusMsg(isOrthoViewMode(viewMode) ? 'Switched to Perspective.' : 'Switched to Orthographic view.');
  }, [viewMode]);

  const handleToggleSolarLock = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.toggleSolarLock();
    setSolarLocked(manager.isSolarLocked());
    setStatusMsg(manager.isSolarLocked() ? 'Solar array position locked.' : 'Solar array position unlocked.');
    setOutlinerRefresh((n) => n + 1);
  }, []);

  const handleToggleObjectLock = useCallback((entry: OutlinerEntry) => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.toggleObjectLock(entry.object);
    setStatusMsg(manager.isObjectLocked(entry.object) ? `"${entry.name}" position locked.` : `"${entry.name}" position unlocked.`);
    setOutlinerRefresh((n) => n + 1);
  }, []);

  const handleSelectOutliner = useCallback((entry: OutlinerEntry) => {
    const manager = managerRef.current;
    if (!manager) return;
    manager.selectOutlinerEntry(entry);
    setSelectedEntryId(entry.id);
    setIsAllSelected(entry.type === 'solar');
  }, []);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    setOutlinerEntries(manager.getOutliner());
  }, [generateTrigger, importedCount, outlinerRefresh, solarLocked]);

  const handleImportMapTo3D = useCallback((canvas: HTMLCanvasElement, widthM: number, heightM: number, centerLat?: number, centerLng?: number) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    setGroundTexture(texture);
    setGroundSize([widthM, heightM]);
    if (centerLat !== undefined && centerLng !== undefined) setSiteCenter({ lat: centerLat, lng: centerLng });
    setStatusMsg(`Map imported to 3D scale: ${widthM.toFixed(1)}x${heightM.toFixed(1)}m`);
    window.setTimeout(() => { managerRef.current?.fitToExtents(); }, 150);
  }, []);

  const handleUploadMapImage = useCallback((img: HTMLImageElement, widthM: number, heightM: number) => {
    const texture = new THREE.Texture(img);
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    setGroundTexture(texture);
    setGroundSize([widthM, heightM]);
    setStatusMsg(`Custom image applied: ${widthM.toFixed(1)}x${heightM.toFixed(1)}m`);
  }, []);

  const handleNew = useCallback(() => {
    setArrays([createArrayConfig('array-1', 'Array 1')]);
    setActiveArrayId('array-1');
    setVariants([createVariant('variant-1', 'Variant 1')]);
    setActiveVariantId('variant-1');
    setStringDesign({ modulesPerString: 0, parallelStrings: 0, tMinC: DEFAULT_STRING_T_MIN, tMaxC: DEFAULT_STRING_T_MAX });
    setPolygons([]);
    setSelectedPolygonId(null);
    setLat(34.1202);
    setLng(72.4700);
    setGroundTexture(null);
    setGroundSize([100, 100]);
    setStatusMsg('New project started.');
  }, []);

    // File handle for the last saved project — lets "Save" overwrite the SAME
    // file instead of downloading a new one every time (File System Access API).
    const savedProjectFileHandleRef = useRef<any>(null);

  const buildProjectJson = useCallback(() => {
    // Keep the active variant in sync with the live design before serializing.

    const liveVariants = variants.map((v) =>
      v.id === activeVariantId
        ? { ...v, arrays: cloneArrays(arrays), activeArrayId, inverterId, systemType, batteryId, batteryQty, cableId, stringDesign, updatedAt: new Date().toISOString() }
        : v,
    );
    const data = buildProjectData(config, polygons, { lat, lng }, 17, {
      projectName,
      arrays,
      inverterId,
      cableId,
      systemType,
      batteryId,
      batteryQty,
      company: { name: companyName, address: companyAddress, phone: companyPhone, email: companyEmail },
      site: { groundTexture: null, groundSize },
      financials,
      variants: liveVariants,
      activeVariantId,
    });
    return JSON.stringify(data, null, 2);
  }, [config, polygons, lat, lng, arrays, inverterId, cableId, systemType, batteryId, batteryQty, companyName, companyAddress, companyPhone, companyEmail, projectName, financials, groundSize, variants, activeVariantId, activeArrayId, stringDesign]);

  /** Download a fresh timestamped copy (Save ▸ Save a Copy). */
  const handleSaveCopy = useCallback(() => {
    const blob = new Blob([buildProjectJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, '_') || 'SolarMount_Project'}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg('Project copy downloaded.');
  }, [buildProjectJson, projectName]);

  /**
   * Smart save: overwrites the file previously saved via the File System
   * Access API; falls back to a one-time "Save as" picker, then to a plain
   * download when the API is unsupported.
   */
  const handleSave = useCallback(async () => {
    const contents = buildProjectJson();
    const picker = (window as any).showSaveFilePicker as ((o?: any) => Promise<any>) | undefined;

    // 1) Overwrite the file the user already saved to.
    if (savedProjectFileHandleRef.current) {
      try {
        const writable = await savedProjectFileHandleRef.current.createWritable();
        await writable.write(new Blob([contents], { type: 'application/json' }));
        await writable.close();
        setStatusMsg(`Project saved → ${savedProjectFileHandleRef.current.name}`);
        return;
      } catch (err) {
        console.warn('[save] overwrite failed, falling back to picker', err);
        savedProjectFileHandleRef.current = null;
      }
    }

    // 2) First save (or handle lost): ask where to store it once.
    if (typeof picker === 'function') {
      try {
        const handle = await picker({
          suggestedName: `${projectName.replace(/\s+/g, '_') || 'SolarMount_Project'}.json`,
          types: [{ description: 'SolarMount Project', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(new Blob([contents], { type: 'application/json' }));
        await writable.close();
        savedProjectFileHandleRef.current = handle;
        setStatusMsg(`Project saved → ${handle.name}`);
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') { setStatusMsg('Save cancelled.'); return; }
        console.warn('[save] picker failed, falling back to download', err);
      }
    }

    // 3) Unsupported browser: plain download.
    handleSaveCopy();
  }, [buildProjectJson, handleSaveCopy, projectName]);

const handleLoad = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      let data: any;
      try {
        data = JSON.parse(e.target?.result as string);
      } catch (err: any) {
        setStatusMsg('Invalid JSON - ' + (err?.message ?? 'could not parse file') + '.');
        return;
      }
      if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
        let nextId = 1; for (const p of polygons) { if (p && typeof p.id === 'number' && p.id > nextId) nextId = p.id;; }
        const polys = importGeoJSON(data, nextId);
        if (polys.length === 0) { setStatusMsg('No polygon features found in GeoJSON.'); return; }
        setPolygons((prev) => [...prev, ...polys]);
        setSelectedPolygonId(polys[0].id);
        setStatusMsg('Imported ' + polys.length + ' building' + (polys.length === 1 ? '' : 's') + ' from GeoJSON.');
        return;
      }
      if (data && (data.settings || data.arrays)) {
        if (typeof data.projectName === 'string' && data.projectName) setProjectName(data.projectName);
        if (Array.isArray(data.polygons)) {

          const loaded = data.polygons.map((p: any) => ({ ...p, id: ++polygonIdCounter } as PolygonData));
          setPolygons(loaded);
          if (loaded.length > 0) setSelectedPolygonId(loaded[0].id);
        }
        const rawArrays: any[] = Array.isArray(data.arrays) && data.arrays.length > 0 ? data.arrays : [];
        const loadedArrays: ArrayConfig[] = rawArrays.length > 0
          ? rawArrays.map((a: any) => ({
              id: a?.id || 'array-1',
              name: a?.name || 'Array 1',
              config: { ...DEFAULT_CONFIG, ...(a?.config || {}) },
              position: a?.position ? { x: Number(a.position.x) || 0,z: Number(a.position.z) || 0 } : { x:  0,z:  0 },
              locked: !!a?.locked,
            }))
          : [createArrayConfig('array-1', 'Array 1', { ...DEFAULT_CONFIG, ...(data.settings || {}) })];
let loadedVariants: ProjectVariant[] | null = Array.isArray(data.variants) && data.variants.length > 0
          ? data.variants.map((v: any) => normalizeVariant(v)).filter((v: ProjectVariant | null): v is ProjectVariant => v !== null)
          : null;
        let activeVariant: ProjectVariant = null as unknown as ProjectVariant;


        if (loadedVariants && loadedVariants.length > 0) {

          const activeId = typeof data.activeVariantId === 'string' && loadedVariants.some((v) => v.id === data.activeVariantId) ? data.activeVariantId : loadedVariants[0].id;
          activeVariant = loadedVariants.find((v) => v.id === activeId) || loadedVariants[0];
        } else {
          activeVariant = createVariant('variant-1', 'Variant 1', {
            arrays: loadedArrays,
            activeArrayId: loadedArrays[0].id,
            inverterId: typeof data.inverterId === 'string' ? data.inverterId : '',
            systemType: data.systemType === 'off-grid' || data.systemType === 'hybrid' || data.systemType === 'pumping' ? data.systemType : 'on-grid',
            batteryId: typeof data.batteryId === 'string' ? data.batteryId : '',
            batteryQty: typeof data.batteryQty === 'number' ? data.batteryQty : 1,
            cableId: typeof data.cableId === 'string' ? data.cableId : (cableModels[0]?.id ?? ''),
          });
          loadedVariants = [activeVariant];
        }
        const current = activeVariant!;
        setArrays(current.arrays);
        setActiveArrayId(current.activeArrayId);
        setInverterId(current.inverterId);
        setSystemType(current.systemType);
        setBatteryId(current.batteryId);
        setBatteryQty(current.batteryQty);
        setCableId(current.cableId);
        setVariants(loadedVariants!);
        setActiveVariantId(current.id);

        const c = data.company;

        if (c) {
          if (typeof c.name === 'string') setCompanyName(c.name);
          if (typeof c.address === 'string') setCompanyAddress(c.address);
          if (typeof c.phone === 'string') setCompanyPhone(c.phone);
          if (typeof c.email === 'string') setCompanyEmail(c.email);
        }
        if (data.site?.groundSize) setGroundSize(data.site.groundSize);
        if (data.financials) setFinancials(data.financials);
        if (data.map?.center && typeof data.map.center.lat === 'number' && typeof data.map.center.lng === 'number') {

          setLat(data.map.center.lat);
          setLng(data.map.center.lng);
        }
        const vcount = (loadedVariants ?? []).length;
        setStatusMsg('Project loaded - ' + vcount + ' variant' + (vcount === 1 ? '' : 's') + ' (active: "' + current.name + '").');
        return;
      }
      if (data && (data.project || data.site || data.pv)) {

        const p = data.project;

        if (p) {
          if (typeof p.name === 'string' && p.name) setProjectName(p.name);
          if (typeof p.quoteNumber === 'string') setQuoteNumber(p.quoteNumber);
          if (typeof p.quoteDate === 'string') setQuoteDate(p.quoteDate);
        }
        const cl = data.client;
        if (cl) {
          if (typeof cl.name === 'string') setClientName(cl.name);
          if (typeof cl.phone === 'string') setClientPhone(cl.phone);
          if (typeof cl.email === 'string') setClientEmail(cl.email);
          if (typeof cl.address === 'string') setClientAddress(cl.address);
        }
        const st = data.site;
        if (st) {
          if (typeof st.address === 'string') setSiteAddress(st.address);
          if (typeof st.lat === 'number') setLat(st.lat);
          if (typeof st.lon === 'number') setLng(st.lon);
        }
        const cm = data.company;
        if (cm) {
          if (typeof cm.name === 'string') setCompanyName(cm.name);
          if (typeof cm.phone === 'string') setCompanyPhone(cm.phone);
          if (typeof cm.email === 'string') setCompanyEmail(cm.email);
          if (typeof cm.address === 'string') setCompanyAddress(cm.address);
        }
        if (data.pv) {
          if (typeof data.pv.panelId === 'string' && data.pv.panelId) setConfig({ ...config, panelId: data.pv.panelId });
          if (typeof data.pv.inverterId === 'string' && data.pv.inverterId) setInverterId(data.pv.inverterId);
        }
        if (data.battery) {
          if (typeof data.battery.id === 'string') setBatteryId(data.battery.id);
          if (typeof data.battery.qty === 'number') setBatteryQty(data.battery.qty);
        }
        if (data.cabling && typeof data.cabling.cableId === 'string') setCableId(data.cabling.cableId);
        if (data.financials) setFinancials(data.financials);
        if (Array.isArray(data.polygons)) {

          const loaded = data.polygons.map((p: any) => ({ ...p, id: ++polygonIdCounter } as PolygonData));
          setPolygons(loaded);
          if (loaded.length > 0) setSelectedPolygonId(loaded[0].id);
        }
        setStatusMsg('GIS data imported - site/GIS info only; use Save (Ctrl+S) to keep the complete design incl. variants.');
        return;
      }
      setStatusMsg('Unrecognized file - expected a SolarMount project (.json), a GIS export or a GeoJSON file.');
    };
    reader.readAsText(file);
  }, [config, polygons, cableModels, lng]);
// Variant management - multiple system designs for the same project
  const handleVariantSelect = useCallback((id: string) => {
    if (id === activeVariantId) { setVariantsOpen(false); return; }
    const target = variants.find((v) => v.id === id);
    if (!target) return;
    const now = new Date().toISOString();
    const updated = variants.map((v) => v.id === activeVariantId ? { ...v, arrays: cloneArrays(arrays), activeArrayId, inverterId, systemType, batteryId, batteryQty, cableId, updatedAt: now } : v);
    setVariants(updated);
    setArrays(cloneArrays(target.arrays));
    setActiveArrayId(target.activeArrayId);
    setInverterId(target.inverterId);
    setSystemType(target.systemType);
    setBatteryId(target.batteryId);
    setBatteryQty(target.batteryQty);
    setCableId(target.cableId);
    setActiveVariantId(target.id);
    setStatusMsg('Switched to variant: ' + target.name);
    setVariantsOpen(false);
  }, [variants, activeVariantId, arrays, activeArrayId, inverterId, systemType, batteryId, batteryQty, cableId]);

  const handleVariantNew = useCallback(() => {
    const id = 'variant-' + Date.now();
    const name = 'Variant ' + (variants.length + 1);
    const created = createVariant(id, name, {
      arrays: cloneArrays(arrays),
      activeArrayId,
      inverterId,
      systemType,
      batteryId,
      batteryQty,
      cableId,
    });
    setVariants((prev) => [...prev, created]);
    setActiveVariantId(id);
    setStatusMsg('Variant ' + name + ' created from the current design.');
    setVariantsOpen(false);
  }, [variants.length, arrays, activeArrayId, inverterId, systemType, batteryId, batteryQty, cableId]);

  const handleVariantRename = useCallback((id: string) => {
    const v = variants.find((x) => x.id === id);
    if (!v) return;
    const name = window.prompt('Variant name:', v.name);
    if (name === null || !name.trim() || name.trim() === v.name) return;
    setVariants((prev) => prev.map((x) => (x.id === id ? { ...x, name: name.trim(), updatedAt: new Date().toISOString() } : x)));
  }, [variants]);

  const handleVariantDelete = useCallback((id: string) => {
    if (variants.length <= 1) { setStatusMsg('Cannot delete the only variant.'); return; }
    const doomed = variants.find((v) => v.id === id);
    if (!doomed || !window.confirm('Delete variant ' + doomed.name + '? This cannot be undone.')) return;
    const wasActive = id === activeVariantId;
    const remaining = variants.filter((v) => v.id !== id);
    setVariants(remaining);
    if (wasActive) {
      const fallback = remaining[0];
      setArrays(cloneArrays(fallback.arrays));
      setActiveArrayId(fallback.activeArrayId);
      setInverterId(fallback.inverterId);
      setSystemType(fallback.systemType);
      setBatteryId(fallback.batteryId);
      setBatteryQty(fallback.batteryQty);
      setCableId(fallback.cableId);
      setActiveVariantId(fallback.id);
      setStatusMsg('Variant deleted - switched to ' + fallback.name);
    } else {
      setStatusMsg('Variant deleted.');
    }
  }, [variants, activeVariantId]);
  const handleExportJPG = useCallback(() => {
    const data = managerRef.current?.exportJPG();
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = 'SolarMount_3D_Render.jpg';
    a.click();
    setStatusMsg('3D JPG exported.');
  }, []);

  // (2D full-screen GIS map view removed — all GIS/tracing logic already lives on the Project page.)

  const handleImport3DFile = useCallback(async (file: File, opts?: { scale?: number; groundSnap?: boolean }) => {
    const result = await importModelFile(file, opts);
    if (managerRef.current) {
      managerRef.current.addImportedObject(result.object);
      setImportedCount((c) => c + 1);
      setStatusMsg(`Imported 3D model: ${result.name}`);
    }
  }, []);

  const handleExport3D = useCallback(async (format: ExportFormat) => {
    const manager = managerRef.current;
    if (!manager) return;
    const objects = manager.getExportObjects();
    if (objects.length === 0) {
      setStatusMsg('Nothing to export — generate a structure or import a model first.');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    await exportSceneAs(format, objects, `SolarMount_${date}`);
    setStatusMsg(`3D scene exported as ${format.toUpperCase()}`);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const profile = await fetchProfile(session.user.id);
        if (profile) setUser(profile);
      }
    })();
    supabase.auth.onAuthStateChange((_event, session) => {
      (async () => {
        if (session?.user) {
          const profile = await fetchProfile(session.user.id);
          if (profile) setUser(profile);
        } else {
          setUser(null);
        }
      })();
    });
  }, []);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setStatusMsg('Signed out.');
  }, []);

  const handleExportBOM = useCallback(() => {
    const stringResult = computeStringSizing(config, layout.totalPanels, inverterId);
    let cableName = '';
    if (stringResult?.ok) {
      const cr = computeCable(stringResult.current, 50, 3, stringResult.voltage);
      if (cr) cableName = cr.cable.name;
    }
    const lines = buildBoM(library, config.panelId, layout.totalPanels, layout.totalKw, inverterId, batteryId || null, batteryQty, cableName);
    const csv = bomToCSV(lines);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BOM_${config.panelId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg('BoM exported — priced from your equipment library.');
  }, [config, layout, inverterId, batteryId, batteryQty, library]);

  const handleGenerate = useCallback(() => {
    if (!user) { setShowAuthModal(true); return; }
    if (user.credits_remaining <= 0) { setStatusMsg('No credits remaining. Please upgrade your plan.'); return; }
    setGenerateTrigger((n) => n + 1);
    decrementCredit(user.user_id, `Generated ${layout.totalPanels} panels`).then((remaining) => {
      if (remaining !== null) {
        setUser({ ...user, credits_remaining: remaining });
        setStatusMsg(`Structure: ${layout.totalPanels} panels on ${activePolygons.length} building(s) — ${remaining} credits left`);
      } else {
        setStatusMsg(`Structure: ${layout.totalPanels} panels on ${activePolygons.length} building(s)`);
      }
    });
  }, [layout, activePolygons, user]);

  // NOTE: this trigger is intentionally only updated when the user explicitly
  // requests a generation pass. Updating it on every project change causes the
  // parent app to re-render in a loop and destabilizes the CAD/3D UI.
  const handleStartDimension = useCallback(() => {
    if (managerRef.current && typeof managerRef.current.startDimensionTool === 'function') {
      managerRef.current.startDimensionTool();
    }
    setDimensionMode(true);
    setStatusMsg('Click two points on the ground/3D viewport to measure.');
  }, []);

  const handleDimensionComplete = useCallback((distance: number) => {
    setDimensionDistance(distance);
    setDimensionMode(false);
    setDimensionPrompt(true);
    setStatusMsg(`Measured ${distance.toFixed(2)}m. Enter the real-world distance to rescale ground.`);
  }, []);

  const handleApplyDimension = useCallback(() => {
    const real = parseFloat(dimensionInput);
    if (!isNaN(real) && real > 0 && dimensionDistance) {
      if (managerRef.current && typeof managerRef.current.applyDimensionScale === 'function') {
        managerRef.current.applyDimensionScale(real);
      } else {
        const ratio = real / dimensionDistance;
        setGroundSize(([w, h]) => [w * ratio, h * ratio]);
      }
      setStatusMsg(`Ground rescaled: ${dimensionDistance.toFixed(2)}m → ${real}m`);
    }
    setDimensionPrompt(false);
    setDimensionInput('');
    setDimensionDistance(null);
  }, [dimensionInput, dimensionDistance]);

  const handleCancelDimension = useCallback(() => {
    if (managerRef.current && typeof managerRef.current.cancelDimensionTool === 'function') {
      managerRef.current.cancelDimensionTool();
    }
    setDimensionMode(false);
    setDimensionPrompt(false);
    setStatusMsg('Dimension tool cancelled.');
  }, []);

  const [objectDimensionDistance, setObjectDimensionDistance] = useState<number | null>(null);
  const [objectDimensionPrompt, setObjectDimensionPrompt] = useState(false);
  const [objectDimensionInput, setObjectDimensionInput] = useState('');

  const handleStartObjectDimension = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const obj = manager.selectedObject;
    if (!obj) {
      setStatusMsg('Select a 3D object (building or imported model) first, then use Scale to Dimension.');
      return;
    }
    if (typeof manager.startObjectDimensionTool === 'function') {
      manager.startObjectDimensionTool(obj);
    }
    setStatusMsg('Click two points on the selected object to measure its real-world dimension.');
  }, []);

  const handleObjectDimensionComplete = useCallback((distance: number) => {
    setObjectDimensionDistance(distance);
    setObjectDimensionPrompt(true);
    setStatusMsg(`Measured ${distance.toFixed(2)}m on object. Enter the real-world distance to scale it.`);
  }, []);

  const handleApplyObjectDimension = useCallback(() => {
    const real = parseFloat(objectDimensionInput);
    if (!isNaN(real) && real > 0 && objectDimensionDistance) {
      if (managerRef.current && typeof managerRef.current.applyObjectDimensionScale === 'function') {
        managerRef.current.applyObjectDimensionScale(real);
      }
      setStatusMsg(`Object scaled: ${objectDimensionDistance.toFixed(2)}m → ${real}m`);
    }
    setObjectDimensionPrompt(false);
    setObjectDimensionInput('');
    setObjectDimensionDistance(null);
  }, [objectDimensionInput, objectDimensionDistance]);

  const handleCancelObjectDimension = useCallback(() => {
    if (managerRef.current && typeof managerRef.current.cancelDimensionTool === 'function') {
      managerRef.current.cancelDimensionTool();
    }
    setObjectDimensionPrompt(false);
    setStatusMsg('Object dimension tool cancelled.');
  }, []);

  // ---- View capture helper ----
  const captureView = useCallback((view: 'top' | 'iso'): Promise<string> => {
    return new Promise((resolve) => {
      const manager = managerRef.current;
      if (!manager) { 
        console.warn('Scene manager not ready for capture');
        resolve(''); 
        return; 
      }
      
      try {
        // Set the view mode first
        setViewMode(view === 'top' ? 'ortho-top' : 'iso');
        
        // Wait for the view to update before capturing
        setTimeout(() => {
          try {
            // Use high-quality export with white background for clean report images
            const data = manager.exportHighQualityImage();
            if (!data) {
              console.warn('Capture returned empty data');
            }
            // Restore the previous view mode after a brief delay
            setTimeout(() => {
              setViewMode(viewMode);
            }, 100);
            resolve(data || '');
          } catch (err) {
            console.error('Capture failed:', err);
            setViewMode(viewMode);
            resolve('');
          }
        }, 500);
      } catch (err) {
        console.error('Capture setup failed:', err);
        resolve('');
      }
    });
  }, [viewMode]);

  // ---- Image capture for ReportView ----
  const handleCaptureImages = useCallback(async () => {
    const top = await captureView('top');
    const iso = await captureView('iso');
    return { top, iso };
  }, [captureView]);

  // ---- Full report export ----
  const handleExportReport = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) {
      setStatusMsg('3D scene not ready.');
      return;
    }

    const topImage = await captureView('top');
    const isoImage = await captureView('iso');

    // ---- ROI (required by generateFullReportHTML) ----
    const roi = computeROI(
      layout.totalKw ?? 0,
      layout.totalPanels ?? 0,
      layout.annualYieldMWh ?? 0,
      financials?.retailRate ?? 0.32,
    );


    const stringResult = computeStringSizing(config, layout.totalPanels, inverterId);
    if (!stringResult || !stringResult.ok) {
      setStatusMsg('String sizing failed. Check inverter and panel compatibility.');
      return;
    }

    const cableResult = computeCable(stringResult.current, 50, 3, stringResult.voltage);
    let cableOutput = null;
    if (cableResult) {
      cableOutput = {
        cable: cableResult.cable.name,
        length: 50,
        voltageDrop: cableResult.voltageDrop,
      };
    }

    const shadeReport = boundaryWarning
      ? `Shading detected: ${boundaryWarning}`
      : 'No significant shading from nearby obstacles based on sun path and building geometry.';

    // Battery section + BoQ built from the equipment library
    const cableOut = cableOutput ? cableOutput.cable : '';
    const bomLines = buildBoM(library, config.panelId, layout.totalPanels, layout.totalKw, inverterId, batteryId || null, batteryQty, cableOut);
    const bomSection = bomTableHTML(bomLines);
    const bomEquipmentTotal = bomLines.reduce((s, l) => s + (l.total ?? 0), 0);

    const batteryModel = batteryId ? library.batteries.find((b) => b.id === batteryId) : null;
    const batterySection = batteryModel
      ? `<h2>🔋 Battery Storage</h2><div class="card">
          <p><strong>${batteryModel.name}</strong> (${batteryModel.manufacturer}) × ${batteryQty}</p>
          <ul style="margin-left:20px; line-height:1.8;">
            <li>Usable capacity: ${(batteryModel.usableKwh * batteryQty).toFixed(1)} kWh (${batteryModel.nominalKwh * batteryQty} kWh nominal)</li>
            <li>Chemistry: ${batteryModel.chemistry} · ${batteryModel.coupling}-coupled</li>
            <li>Round-trip efficiency: ${((batteryModel.roundTripEff ?? 0.95) * 100).toFixed(0)}%</li>
            <li>Continuous / peak power: ${batteryModel.continuousKw} / ${batteryModel.peakKw} kW</li>
            <li>Warranty: ${batteryModel.cycleWarranty} cycles to ${((batteryModel.retentionAtWarranty ?? 0.7) * 100).toFixed(0)}% retention or ${batteryModel.calendarYears} years</li>
            ${batteryModel.listPriceAud ? `<li>List price: $${(batteryModel.listPriceAud * batteryQty).toLocaleString(undefined, { maximumFractionDigits: 0 })}</li>` : ''}
          </ul>
        </div>`
      : '';
          {/* CAD overlays the (still-mounted) 3D viewport like the Report page.
              Lazy-loaded chunk — falls back to a spinner while fetching. */}
    const html = generateFullReportHTML(
      config,
      layout,
      polygons,
      lat,
      lng,
      systemType,
      {
        name: companyName,
        logo: '',
        address: companyAddress,
        phone: companyPhone,
        email: companyEmail,
      },
      stringResult,
      cableOutput,
      roi,
      shadeReport,
      { top: topImage, iso: isoImage },
      '',
      boundaryWarning,
      batterySection,
      bomSection
    );

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Solar_Design_Report_${new Date().toISOString().slice(0,10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg('Full design report generated.');
  }, [config, layout, polygons, lat, lng, systemType, companyName, companyAddress, companyPhone, companyEmail, inverterId, boundaryWarning, captureView, library, batteryId, batteryQty, financials]);

  // ---- Keyboard shortcuts (industry-standard keymap) ----
  const shortcutsEnabled = !libraryOpen && !shortcutsOpen && !importExportOpen && !showAuthModal;
  useKeyboardShortcuts([
    { key: 'g', handler: () => handleSetTransform('translate'), enabled: shortcutsEnabled },
    { key: 'r', handler: () => handleSetTransform('rotate'), enabled: shortcutsEnabled },
    { key: 's', handler: () => handleSetTransform('scale'), enabled: shortcutsEnabled },
    { key: 'd', handler: handleDuplicate, enabled: shortcutsEnabled },
    { key: 'x', handler: handleDelete, enabled: shortcutsEnabled },
    { key: 'Delete', handler: handleDelete, enabled: shortcutsEnabled },
    { key: 'a', handler: handleSelectAll, enabled: shortcutsEnabled },
    { key: 'f', handler: handleFrameAll, enabled: shortcutsEnabled },
    { key: '.', handler: handleZoomToSelected, enabled: shortcutsEnabled },
    { key: 'p', handler: handleCenterPivot, enabled: shortcutsEnabled },
    { key: 'l', handler: handleToggleSolarLock, enabled: shortcutsEnabled },
    { key: 'Tab', shift: true, preventDefault: true, handler: () => setSnapGrid((v) => !v), enabled: shortcutsEnabled },
    { key: 'z', ctrl: true, preventDefault: true, handler: () => {
      const ok = managerRef.current?.undoLastTransform();
      setStatusMsg(ok ? 'Undid last transform.' : 'Nothing to undo.');
    }, enabled: shortcutsEnabled },
    { key: '1', handler: () => { setView('3d'); setViewMode('perspective'); }, enabled: shortcutsEnabled },
    { key: '2', handler: () => { setView('3d'); setViewMode('ortho-top'); }, enabled: shortcutsEnabled },
    { key: '3', handler: () => { setView('3d'); setViewMode('ortho-front'); }, enabled: shortcutsEnabled },
    { key: '4', handler: () => { setView('3d'); setViewMode('ortho-right'); }, enabled: shortcutsEnabled },
    { key: '5', handler: () => { setView('3d'); setViewMode('ortho-left'); }, enabled: shortcutsEnabled },
    { key: '6', handler: () => { setView('3d'); setViewMode('iso'); }, enabled: shortcutsEnabled },
    { key: 'w', handler: () => setWireframe(!wireframe), enabled: shortcutsEnabled },
    { key: '7', handler: () => { setView('3d'); setViewMode('ortho-top'); }, enabled: shortcutsEnabled },
    { key: '8', handler: () => setView('report'), enabled: shortcutsEnabled },
  { key: '9', handler: () => setView('cad'), enabled: shortcutsEnabled },
    { key: '?', handler: () => setShortcutsOpen(true) },
    { key: 'n', ctrl: true, handler: handleNew, preventDefault: true, enabled: shortcutsEnabled },
    { key: 's', ctrl: true, handler: handleSave, preventDefault: true, enabled: shortcutsEnabled },
    { key: 'o', ctrl: true, handler: () => projectFileInputRef.current?.click(), preventDefault: true, enabled: shortcutsEnabled },
    { key: 'e', ctrl: true, handler: handleExportReport, preventDefault: true, enabled: shortcutsEnabled },
  ]);

  // ---- Render ----
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface-950">
      <TopToolbar
        onNew={handleNew}
        onSave={handleSave}
        onLoad={handleLoad}
        onExportJPG={handleExportJPG}
        onExportReport={handleExportReport}
        onExportBOM={handleExportBOM}
        onOpenImportExport={() => setImportExportOpen(true)}
        view={view}
        setView={setView}
        creditsRemaining={user?.credits_remaining ?? null}
        onSignInClick={() => setShowAuthModal(true)}
        onSignOut={handleSignOut}
        onReopenTour={reopenWelcome}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenVariants={() => setVariantsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        unitSystem={unitSystem}
        setUnitSystem={handleSetUnitSystem}
        onSetTransform={handleSetTransform}
        transformMode={transformMode}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onSelectAll={handleSelectAll}
        onMoveAll={handleMoveAll}
        onFrameAll={handleFrameAll}
        showGrid={showGrid}
        setShowGrid={setShowGrid}
        showShadows={showShadows}
        setShowShadows={setShowShadows}
        // NEW: Structural Design Engine button
        onOpenStructuralDesign={handleOpenStructuralDesign}
      />

      <div className="flex flex-1 overflow-hidden relative">
        {view === 'report' && (
          /* Report overlays the (still-mounted) 3D viewport so the scene
             manager stays alive and image capture works from the report. */
          <div className="absolute inset-0 z-[4000] flex bg-surface-950">
          <ReportView
            config={config}
            layout={layout}
            polygons={polygons}
            lat={lat}
            lng={lng}
            inverterId={inverterId}
            setInverterId={setInverterId}
            systemType={systemType}
            setSystemType={setSystemType}
            companyName={companyName}
            setCompanyName={setCompanyName}
            companyAddress={companyAddress}
            setCompanyAddress={setCompanyAddress}
            companyPhone={companyPhone}
            setCompanyPhone={setCompanyPhone}
                        companyEmail={companyEmail}
            setCompanyEmail={setCompanyEmail}
                        projectName={projectName}
            setProjectName={setProjectName}
            financials={financials}
            setFinancials={setFinancials}
            customerName={clientName}
            customerAddress={clientAddress}
            customerPhone={clientPhone}
            customerEmail={clientEmail}
            siteAddress={siteAddress}
            quoteNumber={quoteNumber}
            quoteDate={quoteDate}
            onExportReport={handleExportReport}
            onClose={() => setView('3d')}
            boundaryWarning={boundaryWarning}
            onCaptureImages={handleCaptureImages}
            // NEW: pass library inverters and batteries
            inverters={library.inverters || []}
            batteries={library.batteries || []}
            batteryId={batteryId}
            setBatteryId={setBatteryId}
            batteryQty={batteryQty}
             inverterCount={inverterCount} setInverterCount={setInverterCount}
            panels={libraryPanelsById}
            stringDesignOverride={stringDesign}
          />
          </div>
        )}
        <div className={view === 'cad' ? 'absolute inset-0 z-[4000] flex bg-surface-950' : 'hidden'}>
            {/* CAD overlays the (still-mounted) 3D viewport like the Report page.
              Lazy-loaded chunk — falls back to a spinner while fetching. */}
            <Suspense
              fallback={
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
                  <div className="w-8 h-8 border-2 border-solar-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs uppercase tracking-widest">Loading CAD Workstation…</span>
                </div>
              }
            >
              <CadView
                data={cadData}
                onClose={() => setView('3d')}
                onConfigChange={(patch) => setConfig({ ...config, ...patch })}
              />
            </Suspense>
        </div>
        {view === 'project' && (
          <ProjectView
            lat={lat} lng={lng}
            setLat={setLat} setLng={setLng}
            onLocationChange={handleLocationChange}
            groundSize={groundSize}
            polygons={polygons}
            selectedPolygonId={selectedPolygonId}
            onSelectPolygon={setSelectedPolygonId}
            onPolygonCreated={handlePolygonCreated}
            onDeletePolygon={handleDeletePolygon}
            onDeleteAllPolygons={handleDeleteAll}
            onImportMapTo3D={handleImportMapTo3D}

            panels={library.panels || []}
            inverters={library.inverters || []}
            batteries={library.batteries || []}
            cables={cableModels}
            panelId={config.panelId}
            setPanelId={(id: string) => setConfig({ ...config, panelId: id })}
            inverterId={inverterId} setInverterId={setInverterId}
            batteryId={batteryId} setBatteryId={setBatteryId}
            batteryQty={batteryQty} setBatteryQty={setBatteryQty}
            cableId={cableId} setCableId={setCableId}
            systemType={systemType} setSystemType={setSystemType}
            inverterCount={inverterCount} setInverterCount={setInverterCount}
            mpptMode={mpptMode} setMpptMode={setMpptMode}
            stringDesign={stringDesign} setStringDesign={setStringDesign}

            totalKw={layout.totalKw}
            totalPanels={layout.totalPanels}
            totalArea={layout.totalArea}
            annualYieldMWh={layout.annualYieldMWh}

            projectName={projectName} setProjectName={setProjectName}
            quoteNumber={quoteNumber} setQuoteNumber={setQuoteNumber}
            quoteDate={quoteDate} setQuoteDate={setQuoteDate}
            clientName={clientName} setClientName={setClientName}
            clientPhone={clientPhone} setClientPhone={setClientPhone}
            clientEmail={clientEmail} setClientEmail={setClientEmail}
            clientAddress={clientAddress} setClientAddress={setClientAddress}
            siteAddress={siteAddress} setSiteAddress={setSiteAddress}
            companyName={companyName} setCompanyName={setCompanyName}
            companyPhone={companyPhone} setCompanyPhone={setCompanyPhone}
            companyEmail={companyEmail} setCompanyEmail={setCompanyEmail}
            companyAddress={companyAddress} setCompanyAddress={setCompanyAddress}

            financials={financials} setFinancials={setFinancials}
            unitSystem={unitSystem} setUnitSystem={handleSetUnitSystem}

            onBack={() => setView('3d')}
            onGoToView={(v) => setView(v)}
            onNew={handleNew}
            onSave={handleSave}
            onSaveCopy={handleSaveCopy}
            onOpenFile={handleLoad}
            onImportPolygons={(imported) => setPolygons((prev) => [...prev, ...imported])}
            onOpenLibrary={() => setLibraryOpen(true)}
            config={config}
            onConfigChange={(patch) => setConfig({ ...config, ...patch })}
          />
        )}
        <div className={`flex flex-1 flex-row min-h-0 w-full overflow-hidden ${view === 'project' ? 'hidden' : ''}`}>
            <LeftSidebar
              config={config}
              setConfig={setConfig}
              unitSystem={unitSystem}
              lat={lat}
              lng={lng}
              setLat={setLat}
              setLng={setLng}
              polygons={polygons}
              selectedPolygonId={selectedPolygonId}
              onSelectPolygon={setSelectedPolygonId}
              onTogglePolygonPanels={handleTogglePanels}
              onDeletePolygon={handleDeletePolygon}
              onDeleteAllPolygons={handleDeleteAll}
              onPolygonCreated={handlePolygonCreated}
              onAutoLayout={handleAutoLayout}
              onExtrudeSelected={handleExtrude}
              buildingHeight={buildingHeight}
              setBuildingHeight={setBuildingHeight}
              onSearchLocation={handleSearch}
              panelOverlayRects={panelOverlayRects}
              sunDate={sunDate}
              sunTime={sunTime}
              setSunDate={setSunDate}
              setSunTime={setSunTime}
              sunAzimuth={sunPos.azimuth}
              sunElevation={sunPos.elevation}
              onGenerate={handleGenerate}
              onImportMapTo3D={handleImportMapTo3D}
              onUploadMapImage={handleUploadMapImage}
              totalKw={layout.totalKw}
              totalPanels={layout.totalPanels}
              blockCount={layout.blockCount}
              totalArea={layout.totalArea}
              annualYieldMWh={layout.annualYieldMWh}
              onRenamePolygon={() => {}}
              onAlignMapToBuildings={() => {}}
              onGroundTransform={() => {}}
              onExportReport={handleExportReport}
              onExportBOM={handleExportBOM}
              onStartDimension={handleStartDimension}
              dimensionMode={dimensionMode}
              onStartObjectDimension={handleStartObjectDimension}
              hasImportedObjects={importedCount > 0}
              canScaleSelected={selectedSceneType === 'building' || selectedSceneType === 'imported'}
              inverterId={inverterId}
              setInverterId={setInverterId}
              systemType={systemType}
              setSystemType={setSystemType}
              companyName={companyName}
              setCompanyName={setCompanyName}
              companyAddress={companyAddress}
              setCompanyAddress={setCompanyAddress}
              companyPhone={companyPhone}
              setCompanyPhone={setCompanyPhone}
              companyEmail={companyEmail}
              setCompanyEmail={setCompanyEmail}
              batteryId={batteryId}
              setBatteryId={setBatteryId}
              batteryQty={batteryQty}
              setBatteryQty={setBatteryQty}
              batteryModels={library.batteries}
              panelModels={library.panels}
              inverterModels={library.inverters}
              cableModels={cableModels}
              cableId={cableId}
              setCableId={setCableId}
              shadingProvider={shadingProvider}
              setShadingProvider={setShadingProvider}
              clientName={clientName}
              setClientName={setClientName}
              clientAddress={clientAddress}
              setClientAddress={setClientAddress}
              clientPhone={clientPhone}
              setClientPhone={setClientPhone}
              clientEmail={clientEmail}
              setClientEmail={setClientEmail}
              quoteNumber={quoteNumber}
              setQuoteNumber={setQuoteNumber}
              siteAddress={siteAddress}
              setSiteAddress={setSiteAddress}
              quoteDate={quoteDate}
              setQuoteDate={setQuoteDate}
              onOpenLibrary={() => setLibraryOpen(true)}
              outlinerEntries={outlinerEntries}
              selectedEntryId={selectedEntryId}
              onSelectOutliner={handleSelectOutliner}
              onToggleObjectLock={handleToggleObjectLock}
              isOrtho={isOrthoViewMode(viewMode)}
              onToggleOrtho={handleToggleOrtho}
              transformMode={transformMode}
              onSetTransformMode={handleSetTransform}
              selectedPos={selectedPos}
              onSetPosition={handleSetSelectedPosition}
              onMoveSelected={handleMoveSelected}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onZoomToSelected={handleZoomToSelected}
            />

            <main className="flex-1 relative overflow-hidden bg-surface-950 order-1 min-w-0">
              <Viewport3D
                arrays={arrays}
                activeArrayId={activeArrayId}
                activePolygons={activePolygons}
                sunAzimuth={sunPos.azimuth}
                sunElevation={sunPos.elevation}
                showGrid={showGrid}
                showShadows={showShadows}
                snapGrid={snapGrid}
                setSnapGrid={setSnapGrid}
                snapMesh={snapMesh}
                setSnapMesh={setSnapMesh}
                groundTexture={groundTexture}
                groundSize={groundSize}
                solarAnchor={solarAnchor}
                viewMode={viewMode}
                setViewMode={setViewMode}
                wireframe={wireframe}
                setWireframe={setWireframe}
                setShowGrid={setShowGrid}
                setShowShadows={setShowShadows}
                onFrameAll={handleFrameAll}
                transformMode={transformMode}
                onObjectSelect={handleObjectSelect}
                generateTrigger={generateTrigger}
                onManagerReady={(m) => {
                  managerRef.current = m;
                  if (m) {
                    m.onDimensionComplete = handleDimensionComplete;
                    m.onObjectDimensionComplete = handleObjectDimensionComplete;
                    m.onBoundaryWarning = (msg) => {
                      if (msg) setBoundaryWarning(msg);
                    };
                    // Fired once per gizmo drag (drag end): persist the array's
                    // new position. Marking it locked makes generateStructure
                    // restore this position on every rebuild instead of the
                    // array snapping back to its origin.
                    m.onArrayPositionChange = (arrayId, x, z) => {
                      setArrays((prev) =>
                        prev.map((a) => (a.id === arrayId ? { ...a, position: { x, z }, locked: true } : a))
                      );
                    };
                  }
                }}
              />
              {view === '3d' && (
                <HUDOverlay
                  totalKw={layout.totalKw}
                  totalPanels={layout.totalPanels}
                  blockCount={layout.blockCount}
                  totalArea={layout.totalArea}
                  annualYieldMWh={layout.annualYieldMWh}
                />
              )}
              {view === '3d' && (
                <EditToolbar
                  transformMode={transformMode}
                  onSetTransform={handleSetTransform}
                  onDuplicate={handleDuplicate}
                  onDelete={handleDelete}
                  onSelectAll={handleSelectAll}
                  onMoveAll={handleMoveAll}
                  onFrameAll={handleFrameAll}
                  onZoomToSelected={handleZoomToSelected}
                  onCenterPivot={handleCenterPivot}
                  onToggleLock={handleToggleSolarLock}
                  isLocked={solarLocked}
                  hasSelection={!!selectedSceneType || isAllSelected || !!selectedEntryId}
                  wireframe={wireframe}
                  setWireframe={setWireframe}
                  showShadows={showShadows}
                  setShowShadows={setShowShadows}
                  snapGrid={snapGrid}
                  setSnapGrid={setSnapGrid}
                  snapMesh={snapMesh}
                  setSnapMesh={setSnapMesh}
                />
              )}
              {boundaryWarning && (
                <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[2400] max-w-[80%] px-4 py-2 rounded-lg bg-amber-500/15 border border-amber-400/40 text-amber-300 text-[11px] font-semibold text-center shadow-lg glass-strong">
                  ⚠ {boundaryWarning}
                </div>
              )}
              <StatusBar message={statusMsg} />
            </main>
          </div>
      </div>

      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onAuthSuccess={(profile) => { setUser(profile); setShowAuthModal(false); setStatusMsg(`Welcome! ${profile.credits_remaining} design credits available.`); }}
        />
      )}
      {showWelcome && (
        <WelcomeModal
          onClose={skipWelcome}
          onStartTour={startTour}
          onSkip={skipWelcome}
        />
      )}
      {showTour && (
        <TourOverlay steps={TOUR_STEPS} onDone={endTour} />
      )}
      <ImportExportModal
        isOpen={importExportOpen}
        onClose={() => setImportExportOpen(false)}
        onImportFile={handleImport3DFile}
        onExport={handleExport3D}
        hasSceneContent={layout.totalPanels > 0 || importedCount > 0}
        onScaleObject={handleStartObjectDimension}
        hasImportedObjects={importedCount > 0}
      />

      {objectDimensionPrompt && (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="glass-strong rounded-xl border border-surface-600 shadow-2xl p-5 w-80 animate-scale-in">
            <h3 className="text-sm font-bold text-white mb-1">Scale Object to Dimension</h3>
            <p className="text-xs text-slate-400 mb-3">Measured {objectDimensionDistance?.toFixed(2)}m on the object. Enter the real‑world distance (meters):</p>
            <input
              type="number"
              className="field-input mb-3"
              value={objectDimensionInput}
              autoFocus
              onChange={(e) => setObjectDimensionInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleApplyObjectDimension(); if (e.key === 'Escape') handleCancelObjectDimension(); }}
              placeholder="e.g. 10.5"
            />
            <div className="flex gap-2">
              <button className="btn-primary flex-1 justify-center" onClick={handleApplyObjectDimension}>Apply Scale</button>
              <button className="btn-outline flex-1 justify-center" onClick={handleCancelObjectDimension}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {dimensionPrompt && (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="glass-strong rounded-xl border border-surface-600 shadow-2xl p-5 w-80 animate-scale-in">
            <h3 className="text-sm font-bold text-white mb-1">Scale with Dimension</h3>
            <p className="text-xs text-slate-400 mb-3">Measured {dimensionDistance?.toFixed(2)}m in 3D. Enter the real‑world distance (meters):</p>
            <input
              type="number"
              className="field-input mb-3"
              value={dimensionInput}
              autoFocus
              onChange={(e) => setDimensionInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleApplyDimension(); if (e.key === 'Escape') handleCancelDimension(); }}
              placeholder="e.g. 10.5"
            />
            <div className="flex gap-2">
              <button className="btn-primary flex-1 justify-center" onClick={handleApplyDimension}>Apply Scale</button>
              <button className="btn-outline flex-1 justify-center" onClick={handleCancelDimension}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden project file input for Ctrl+O */}
      <input ref={projectFileInputRef} type="file" accept=".json" className="hidden"
        onChange={(e) => { if (e.target.files?.[0]) handleLoad(e.target.files[0]); e.target.value = ''; }} />

      {/* Equipment library + shortcuts modals */}
      <EquipmentLibraryModal
        isOpen={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        library={library}
        onApply={(lib) => { setLibrary(lib); saveLibrary(lib); }}
        onReset={() => { setLibrary(resetLibrary()); }}
      />
      <ShortcutsModal isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <VariantsModal
        isOpen={variantsOpen}
        onClose={() => variantsOpen}
        variants={variants}
        activeVariantId={activeVariantId}
        onSelect={handleVariantSelect}
        onNew={handleVariantNew}
        onRename={handleVariantRename}
        onDelete={handleVariantDelete}
      />

      {/* NEW: Structural Design Engine Modal */}
      {showStructuralDesign && (
        <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-[95vw] max-w-7xl max-h-[90vh] overflow-auto rounded-2xl border border-slate-700 bg-slate-950">
            <div className="flex justify-between items-center p-4 border-b border-slate-800 sticky top-0 bg-slate-950 z-10">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Mountain className="w-5 h-5 text-amber-400" />
                Structural Design Engine
              </h2>
              <button 
                onClick={() => setShowStructuralDesign(false)} 
                className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4">
              <StructuralDesignEngine
                initialSystemType={config.structureType === 'ELEVATED' ? 'ELEVATED' : 'FIXED_TILT'}
                initialInputs={{
                  tiltAngleDeg: config.tilt,
                  // Module length along the tilt axis (portrait = long side,
                  // landscape = short side) — matches the renderer + sidebar.
                  panelLengthMm: Math.round(
                    (config.isLandscape
                      ? (PANEL_DB[config.panelId]?.w ?? 1.134)
                      : (PANEL_DB[config.panelId]?.h ?? 2.278)) * 1000,
                  ),
                  frontClearanceMm: config.minFrontHeight ? config.minFrontHeight * 1000 : 450,
                  // Derive the supported span from the live design the same way
                  // the renderer lays out legs (LeftSidebar's standards-based
                  // mapping): legCountX support columns across the block width.
                  legSpacingMm: (() => {
                    const p = PANEL_DB[config.panelId];
                    const panelW = config.isLandscape ? (p?.h ?? 1.134) : (p?.w ?? 1.134);
                    const blockW = config.cols * panelW + Math.max(0, config.cols - 1) * (config.panelSpacingX ?? 0.02);
                    const inset = Math.min(0.2, blockW * 0.1);
                    return Math.max(
                      200,
                      Math.round(((blockW - 2 * inset) / Math.max(1, (config.legCountX ?? 2) - 1)) * 1000),
                    );
                  })(),
                  // Regional wind standard (same default region as the sidebar).
                  windSpeedKmh: WIND_REGIONS[getRegionForCountry('UAE')]?.basicWindSpeedKmh ?? 130,
                  profileType: config.profileType,
                  profileSizeIndex: config.profileSizeIndex,
                }}
                specMeta={{
                  projectName: projectName || 'Solar Project',
                  client: clientName || '—',
                  siteAddr: siteAddress || '—',
                  drawnBy: companyName || 'SolarMount CAD',
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}