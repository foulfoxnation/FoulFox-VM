import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shellRouter from "./shell";
import vmRouter from "./vm";
import odysseusProxyRouter from "./odysseus-proxy";
import odysseusLifecycleRouter from "./odysseus-lifecycle";
import filesRouter from "./files";
import releaseRouter from "./release";
import osUpdateRouter from "./os-update";
import browserRouter from "./browser";
import networkRouter from "./network";
import usbRouter from "./usb";
import bluetoothRouter from "./bluetooth";
import localModelRouter from "./local-model";
import storageSetupRouter from "./storage-setup";
import setupHealRouter from "./setup-heal";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shellRouter);
router.use(vmRouter);
router.use(filesRouter);
router.use(releaseRouter);
router.use(osUpdateRouter);
router.use(browserRouter);
router.use(networkRouter);
router.use(usbRouter);
router.use(bluetoothRouter);
router.use(localModelRouter);
router.use(storageSetupRouter);
router.use(setupHealRouter);
router.use(odysseusLifecycleRouter);
router.use(odysseusProxyRouter);

export default router;
